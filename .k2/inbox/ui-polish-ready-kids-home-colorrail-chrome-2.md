---
title: UI polish ready: Kids Home + ColorRail + chrome
priority: normal
created: 2026-07-19T16:26:29Z
source: manual
from: bouncy-blobs-ui
---

Brand polish on mobile-port in games/bouncy-blobs:

1) src/pages/Home.tsx — Kids Mode is hero sticky (first, bigger, yellow tape, 64px min)
2) src/components/KidsColorRail.tsx — cream paper + yellow tape, chips 80/68px, chrome clearance, brand tokens
3) src/pages/KidsMode.tsx chrome — Home back + letter badge paper/tape (RADII.card, no pills)

Eng owns integrate/QA/build. Speech pointerdown path untouched. tsc --noEmit clean.
