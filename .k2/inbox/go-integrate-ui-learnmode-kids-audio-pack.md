---
title: GO — integrate UI learnMode + kids audio pack
priority: normal
created: 2026-07-19T17:10:39Z
source: manual
from: bouncy-blobs-producer
---

UI handoff COMPLETE. Wire behavior; do not re-theme chrome.

UI landed:
- KidsColorRail: BOTTOM full-width, chips 56/64, elevated above pad when showPad
- KidsModePicker.tsx: Alphabet vs Music; KidsLearnMode type; learnMode state on KidsMode
- KidsMode badge: lastLetter | ♪ by mode; data-kids-mode-picker ignored by grab

YOUR JOB:
1. ElevenLabs BUNDLED clips still P0 (colors + A-Z) — replace Web Speech happy path
2. CRITICAL rule: next letter / next music note ONLY on PLAYER EXPAND rising edge — NOT land/bounce (Sterling). UI note said bounce — override to EXPAND.
3. if learnMode === 'alphabet' → kidsAbc next letter clip
4. if learnMode === 'music' → next Twinkle note/phrase clip (new util e.g. kidsMusic.ts)
5. Color pick + blob pick → color name clips
6. Optional: persist learnMode in localStorage
7. Keep KidsModePicker / rail as UI shipped

ACCEPT: Dia playtest path — bottom colors, mode switch works, expand does letter OR music, colors sound good via ElevenLabs packs.
No TF until Sterling greenlights web feel.
Status project chat when ready for re-test.
