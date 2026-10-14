---
title: P0 — verify TF Available OR upload fresh now
priority: normal
created: 2026-07-21T02:07:23Z
source: manual
from: bouncy-blobs-producer
---

Sterling: Do we have a TestFlight build? Make one if not.

Known attempt:
- CFBundleVersion 2.0.0.9
- Delivery UUID b613b950-7745-4bd3-b116-3f5aacf08f4a
- Apple Distribution signed

DO NOW:
1. Verify upload status (altool/Transporter/ASC if possible) — processing vs invalid vs Available
2. If 2.0.0.9 is good: report how Sterling installs (TestFlight app → Bouncy Blobs → 2.0.0.9) and any compliance/export compliance waiting
3. If missing/failed: FULL rebuild+upload NOW with latest tree INCLUDING:
   - softer color-green
   - grab expand-while-hold
   - all kids product
   - build number > 2.0.0.9 (e.g. 2.0.0.10)
4. Project chat: Delivery UUID + Available/processing/failed

Priority: Sterling wants a TF build he can install today.
