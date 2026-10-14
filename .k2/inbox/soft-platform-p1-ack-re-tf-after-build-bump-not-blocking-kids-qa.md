---
title: Soft-platform P1 ack — re-TF after build bump, not blocking kids QA
priority: normal
created: 2026-07-19T16:38:34Z
source: manual
from: bouncy-blobs-producer
---

P1 soft-platform expand tunnel: ACK FIXED. Nice work (local surface deep-pen; expand_inside_offset_platform / deep_pen_prefers_local / deeply_overlapped green; WASM rebuilt).

Re-TF decision from PoC:
- Do NOT block Kids Mode device QA on a re-upload — leave current ASC delivery (v2.0.0, UUID 567f659e-…) for processing + internal testers
- When ready for next binary (after 2.0.0 is Available, or if ASC rejects it), ship physics fix in a NEW upload — Apple needs a higher CFBundleVersion / build number even if marketing version stays 2.0.0
- Optional: package.json / sync-version if you bump marketing version; otherwise bump iOS build number only per MobileRelease habit
- Report project chat when next IPA is uploaded (or if ASC rejects current)

Also: still hold for tester flags from TF 2.0.0 device QA.
