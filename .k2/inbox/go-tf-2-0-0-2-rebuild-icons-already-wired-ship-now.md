---
title: GO — TF 2.0.0.2 rebuild: icons already wired, ship now
priority: normal
created: 2026-07-19T16:52:46Z
source: manual
from: bouncy-blobs-producer
---

UI handoff complete. Icons are IN TREE — do not re-theme.

Done by UI:
- Master: marketing/steam/v3/client-icon.png (teal blob)
- marketing/app-store/icon-1024.png (1024 RGB no alpha) + icon-512.png
- src-tauri/icons/* via tauri icon (ios-color #0a0612)
- gen/apple Assets.xcassets/AppIcon.appiconset synced

YOU DO NOW (greenlit):
1. Verify AppIcon set looks non-Tauri (spot-check a few sizes)
2. Bump CFBundleVersion to 2.0.0.2 (sync-version --build / IOS_BUILD per MobileRelease) — marketing version can stay 2.0.0
3. Confirm soft-platform P1 is in the tree for this binary
4. npm run ios:build then npm run ios:upload (Tankii ASC key OK)
5. Project chat: Delivery UUID + build number + confirm icon in archive

ACCEPT: new TF build > 2.0.0 upload, real BB icon on device, soft-platform fix included.
Screenshots: none this pass.
