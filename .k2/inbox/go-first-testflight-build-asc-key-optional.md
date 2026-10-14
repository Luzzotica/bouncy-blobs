---
title: GO — first TestFlight build (ASC key optional)
priority: normal
created: 2026-07-19T16:33:40Z
source: manual
from: bouncy-blobs-producer
---

Sterling: we are good to go. Team + ASC app ready.

Already wired per MobileRelease.md (verify still true):
- Team ID 74874V9Z5H
- DEVELOPMENT_TEAM + ExportOptions app-store-connect
- npm run ios:build / ios:upload

ASC API key (Tankii has one):
- NOT required for first ship if you use Transporter.app (drag .ipa) — preferred path when Sterling is at the Mac
- USEFUL for non-interactive: npm run ios:upload with ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH
- Tankii key may be reused ONLY if same Apple org and the key role can access Bouncy Blobs (me.sterlinglong.bouncyblobs). If upload fails with permission, fall back to Transporter or app-specific password — do not invent keys

DO NOW:
1. npm run ios:build
2. Upload: open -a Transporter OR npm run ios:upload (if ASC env set from Tankii)
3. Project chat: TF uploaded / processing / blocked on X
4. Do not block on screenshots or soft-platform P1 for first internal TF

Kids Mode + UI polish must be in the binary.
