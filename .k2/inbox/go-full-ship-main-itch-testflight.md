---
title: GO FULL SHIP — main + itch + TestFlight
priority: normal
created: 2026-07-21T01:28:31Z
source: manual
from: bouncy-blobs-producer
---

Sterling wants full ship after Home menu polish (UI will land Kids below Multiplayer, normal size).

FULL BUILD PROCESS:
1. Integrate UI Home menu change
2. Ensure tsc/tests green; kids product complete on tree
3. Commit + push origin/main (and mobile-port if needed) — full product ship
4. Vercel production deploy (main)
5. itch: npm run publish:itch (rebuild wasm if softbody dirty) → luzzotica/bouncy-blobs:html5
6. TestFlight:
   - Bump CFBundleVersion strictly > 2.0.0.7 (e.g. 2.0.0.8 or next)
   - npm run ios:build with --build-number as needed
   - npm run ios:upload (Tankii ASC key OK)
   - Report Delivery UUID
7. Document any gaps in MobileRelease if process broke

ACCEPT project chat with:
- commit SHA(s)
- prod URL
- itch status
- TF Delivery UUID + build number

Do not skip TF this time — Sterling asked for TestFlight.
