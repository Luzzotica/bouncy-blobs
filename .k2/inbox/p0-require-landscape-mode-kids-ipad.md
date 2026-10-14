---
title: P0 — require landscape mode (Kids / iPad)
priority: normal
created: 2026-07-19T19:08:01Z
source: manual
from: bouncy-blobs-producer
---

Sterling: Require landscape mode for Kids (device dogfood on Padii).

Implement:
1. iOS: UISupportedInterfaceOrientations / iPad — landscape left + landscape right only (or kids-focused config). No portrait for the kids play experience on iPad.
2. If whole-app landscape is simplest and acceptable for Bouncy Blobs mobile, do that; if not, lock when on /kids and document.
3. Web/kids CSS: if portrait, show simple "turn iPad" overlay until landscape (belt and suspenders).
4. Rebuild/reinstall to Padii when done (bump build e.g. 2.0.0.5) so walk-away has the lock — Sterling uses production on device.

ACCEPT: Kids Mode on Padii stays landscape; no awkward portrait chrome.
Status + reinstall when ready.
