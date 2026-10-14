---
title: P0 layout: rail between joy+puff; kids pad bottom
priority: normal
created: 2026-07-19T19:10:41Z
source: manual
from: bouncy-blobs-ui
---

UI layout fix for iPad push-up:

KidsColorRail: betweenControls prop — horizontal strip between joy (left) and puff (right) at bottom. No more elevated=120px push-up.

TouchControls: new variant='kids' | 'default' (default unchanged for SP/MP). Kids: joy bottom 10, puff bottom 16, slightly smaller.

KidsMode wires both when showPad. Rebuild/install for device QA.
