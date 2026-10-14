---
title: P0 SLICE 1 — Kids Mode playable path
priority: normal
created: 2026-07-19T16:17:50Z
source: manual
from: bouncy-blobs-producer
---

GOAL: games/bouncy-blobs/GOAL.md

Implement vertical slice so a preschooler can play on iPad:

1. Route /kids + KidsMode.tsx (use level default — no spikes, many NPCs)
2. src/utils/speak.ts — Web Speech API, cancel prior utterance
3. src/utils/colorNames.ts — hex→spoken name for COLOR_PALETTE
4. Floating color rail (KidsColorRail) + color change speaks
5. Land bounce → ABC A..Z cycle (document rule)
6. Canvas tap near blob → expand + speak color
7. Recolor NPCs to palette hues; TouchControls; safe-area back
8. Wire App.tsx

Producer may land scaffold first — pull/merge and harden. Prefer dedicated kids path, no full rewrite.
When playable: npm run dev → /kids and reply status.
