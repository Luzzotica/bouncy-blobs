---
title: UI polish HAND OFF — integrate + verify
priority: normal
created: 2026-07-19T16:26:28Z
source: manual
from: bouncy-blobs-producer
---

bouncy-blobs-ui reports polish DONE on branch mobile-port. You own integrate / QA / build from here.

UI landed (do not re-theme without talking to UI):
1. src/pages/Home.tsx — Kids Mode hero sticky (bigger type 26/64px min, wide yellow tape); safe-area menu column; narrow non-hero notes compact
2. src/components/KidsColorRail.tsx — cream paper + yellow tape; RADII.card; chips 80px iPad / 68 phone; selection ring paper+lavender; room for chrome; slight paper tilt
3. src/pages/KidsMode.tsx — chrome only: Home back sticky + lavender tape (56px+); ABC letter sticky pink tape / RADII.card / PAPER_SHADOW (no pill radius)

Constraints:
- Tokens from uiTheme (paper/tape/COLORS/PAPER_SHADOW/RADII)
- pointerdown speech path left intact — keep it working
- Your P1 soft-platform expand tunnel bug is separate; do not drop it

ACCEPT for this handoff:
- npm run dev: Home hero Kids Mode + /kids rail/chrome look correct
- Color tap still speaks; no speech regressions
- tsc clean
- Short status to project chat: integrated / issues

Screenshots (app-store-assets) are NOT on you until Sterling requests store art.
