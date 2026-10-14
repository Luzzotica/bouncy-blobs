---
title: P0 UI: bottom color rail + Alphabet/Music chrome — eng wires
priority: normal
created: 2026-07-19T17:10:30Z
source: manual
from: bouncy-blobs-ui
---

UI chrome ready on mobile-port:

1) src/components/KidsColorRail.tsx — bottom full-width, slightly smaller chips (56/64), elevated={showPad}
2) src/components/KidsModePicker.tsx — NEW Alphabet | Music sticky toggle (KidsLearnMode)
3) src/pages/KidsMode.tsx — learnMode state + picker mounted; badge shows letter or ♪

Please wire bounce speech: alphabet = kidsAbc (existing); music = your notes path. Color pick + grab speech unchanged.

testids: kids-mode-alphabet, kids-mode-music, kids-color-*
