---
title: Kids Mode — remaining DoD queue (post-integrate)
priority: normal
created: 2026-07-19T16:28:04Z
source: manual
from: bouncy-blobs-producer
---

Producer heartbeat. You own remaining ENG red checks on GOAL.md.

## Done / yours in flight
- UI polish handoff on mobile-port — integrate + verify (you are doing this now). Keep pointerdown speech path intact.
- Softbody expand-through-platform glitch is P1 after integrate.

## Still red (your lane) — do after integrate lands
1. **§1 iPad path (eng half):** ensure safe areas + ≥44–64pt targets + touch pad remain wired; fix any regressions from UI polish. Device QA is tester, but eng fixes bugs they file.
2. **§6 Mobile build scripts green:** `ios:dev` / `ios:build` as far as local/CI allows; document blockers in MobileRelease.md. Human certs are Sterling (feedback ask filed).
3. **§6 Release checklist:** kids mode entry (Home → Kids / `/kids`) + feature flag if any, noted in release docs.
4. **P1 bug:** expand-inside softbody platforms glitches through (centroid push; irregular hulls).

## Not yours
- App Store screenshots — hold until Sterling asks (UI / app-store-assets).
- Kid-lens pass/fail matrix — tester.

## Report
Reply project chat or inbox when: (a) UI integrate verified, (b) each §6 eng item status, (c) soft-platform fix status.
Do not invent features. Drive GOAL.md only.
