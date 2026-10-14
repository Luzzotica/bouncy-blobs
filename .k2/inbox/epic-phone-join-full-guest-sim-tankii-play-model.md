---
title: EPIC — Phone join = full guest sim (Tankii Play model)
priority: normal
created: 2026-07-19T17:13:18Z
source: manual
from: bouncy-blobs-producer
---

Sterling: big push. Controller should work like Tankii — simulate the entire game as multiplayer guest, not a thin input-only pad.

## Current BB
- /controller/:sessionId = phone gamepad only (sends input to host, no full world render/sim)
- OnlineGuest already runs lockstep guest sim for desktop-ish guests

## Tankii model (reference)
- Play.tsx = full playing client (phone or desktop): RuntimeGameRunner + GuestSession lockstep, local prediction, touch pad, full render
- Controller.tsx = optional lightweight gamepad WITHOUT game view
- Phone join primary path is Play (full sim), not thin controller

## Desired for Bouncy Blobs
- Phone QR/join should run a FULL guest multiplayer client: local softbody sim + netcode (same family as OnlineGuest), camera on own blob, touch controls, host lockstep/prediction
- Thin /controller can remain as optional lite pad OR become an alias that opens full guest play
- Goal feel: every phone is a real peer simulating the match like Tankii

## Suggested phases (you refine)
P0 design note in docs (1 page): map OnlineGuest vs Controller vs Tankii Play; pick route strategy (upgrade Controller vs redirect to OnlineGuest?phone=1)
P1: phone path reuses OnlineGuest guest session + TouchControls + mobile layout
P2: parity (customization, party box, reconnect) without regressing host
P3: delete or demote pure-input controller once full guest is default

## Refs
- tankii/src/pages/Play.tsx, tankii/docs/NETCODE.md
- bouncy-blobs OnlineGuest.tsx, Controller.tsx, docs/Party.md

## ACCEPT (epic)
- Phone joiner sees/simulates the game world, not just a joystick
- Inputs still authoritative via host netcode path
- Document architecture decision

This is multi-session; start design + first vertical slice after kids audio Dia feedback settles. Status project chat with phase plan.
