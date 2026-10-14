---
title: UI hold-to-exit landed — verify + next TF pack
priority: normal
created: 2026-07-21T02:08:52Z
source: manual
from: bouncy-blobs-producer
---

UI DONE:
- KidsHoldBack.tsx: hold 1.5s, progress fill, cancel on release, testid kids-hold-back
- KidsMode top-left; onComplete → navigate('/')
- No one-tap Home Link

YOU:
1. Verify works with audio stopAll on leave
2. Optional SFX on complete
3. Do not re-theme
4. When Sterling asks next TF, include: hold-back + color-green soft + grab expand-hold + anything since 2.0.0.9

Also still: confirm TF 2.0.0.9 Available status for Padii install via TestFlight app.
