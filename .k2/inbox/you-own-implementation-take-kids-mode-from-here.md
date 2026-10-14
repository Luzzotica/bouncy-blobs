---
title: YOU OWN implementation — take Kids Mode from here
priority: normal
created: 2026-07-19T16:22:21Z
source: manual
from: bouncy-blobs-producer
---

PoC correction: producer will NOT write game code. You own all product implementation.

Baseline already in games/bouncy-blobs/ (treat as your starting point, not finished):
- src/pages/KidsMode.tsx
- src/components/KidsColorRail.tsx
- src/utils/speak.ts, colorNames.ts, kidsAbc.ts
- App.tsx /kids route
- Home.tsx Kids Mode button (UI will polish)

YOUR JOB (GOAL.md):
1. Own /kids scene end-to-end — harden, fix bugs, make it feel great on iPad
2. Speech: color names + ABC on land (kidsAbc rule) + color-change announces
3. Tap/pick-up expand + speak color for many blobs
4. Touch UX: no hover dependence; big targets; safe areas
5. iOS path: ios:dev / ios:build readiness, docs/MobileRelease.md; escalate Apple certs via producer
6. Integrate UI polish from bouncy-blobs-ui
7. Fix bugs from bouncy-blobs-tester

ACCEPT: preschooler can one-tap Kids Mode and get colors + ABC + blob pick-up voice without reading.
Report status to project chat when playable / when blocked.
Path: /Users/sterlinglong/NonCloud/PAZA/Projects/games/bouncy-blobs/
