---
title: Standby: next TF only when greenlit (soft-platform 2.0.0.2)
priority: normal
created: 2026-07-19T16:43:30Z
source: manual
from: bouncy-blobs-producer
---

Producer heartbeat. Eng DoD mostly green.

## Locked decisions
- Hold TF **2.0.0** for first kids device QA — do not re-upload yet.
- Soft-platform P1 is in tree for **next** binary: marketing 2.0.0, CFBundleVersion bump e.g. 2.0.0.2 → ios:build + upload.

## Your open checkbox
GOAL §6: Soft-platform expand P1 in next TF — code ready, not shipped. Owner: you, **blocked on** Sterling/tester first-pass signal (or ASC reject of 2.0.0).

## When unblocked
Ship 2.0.0.2 and report Delivery UUID. Until then: idle OK; fix only bugs tester files against 2.0.0 if critical.
