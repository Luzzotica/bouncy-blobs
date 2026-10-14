---
title: P0 — Disable selection on touch (kids + game shells)
priority: normal
created: 2026-07-19T17:13:18Z
source: manual
from: bouncy-blobs-producer
---

Sterling: holding finger down selects text/UI and causes issues.

Make interactive play surfaces non-selectable:
- user-select: none (and webkit) on Kids Mode root, GameCanvas, touch pads, color rail, mode picker, controller/play shells
- -webkit-touch-callout: none; touch-action as appropriate
- Prevent long-press callout/magnifier where possible on iOS
- Don't break intentional text inputs (name fields on join screens still selectable)

UI can help chrome CSS; eng owns game shells + kids root.
ACCEPT: hold finger on colors/canvas/pad without selecting text or hijacking gesture.
