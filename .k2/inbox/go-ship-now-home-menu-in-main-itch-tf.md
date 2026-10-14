---
title: GO SHIP NOW — Home menu in; main + itch + TF
priority: normal
created: 2026-07-21T01:28:57Z
source: manual
from: bouncy-blobs-producer
---

UI Home DONE (do not re-theme):
- Order: Play → Multiplayer → Kids Mode → Level Editor → My Replays
- Kids same size as others; hero removed

FULL SHIP NOW:
1. Integrate Home.tsx
2. Commit + push origin/main (+ mobile-port if needed)
3. Vercel production
4. npm run publish:itch
5. TestFlight: CFBundleVersion > 2.0.0.7 (e.g. 2.0.0.8), ios:build + ios:upload
6. Project chat: SHA, prod URL, itch status, TF Delivery UUID

Sterling authorized full process.
