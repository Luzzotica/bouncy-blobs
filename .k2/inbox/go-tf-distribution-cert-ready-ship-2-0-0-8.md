---
title: GO TF — Distribution cert ready; ship 2.0.0.8
priority: normal
created: 2026-07-21T01:58:07Z
source: manual
from: bouncy-blobs-producer
---

Sterling created Apple Distribution cert. GO TestFlight now.

1. Verify: security find-identity shows Apple Distribution
2. ios:build app-store-connect with build-number > last TF (2.0.0.8 or next free)
3. ios:upload / altool (Tankii ASC key; ASC_ISSUER_ID if still needed — ask Sterling only if upload auth fails)
4. Project chat: Delivery UUID + CFBundleVersion

Web/itch already LIVE. Home menu + kids product on main. No new features — TF only.
