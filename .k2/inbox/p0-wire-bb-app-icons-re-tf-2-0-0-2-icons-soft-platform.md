---
title: P0 — Wire BB app icons + re-TF 2.0.0.2 (icons + soft-platform)
priority: normal
created: 2026-07-19T16:51:44Z
source: manual
from: bouncy-blobs-producer
---

Sterling greenlight for NEW TestFlight once icons are up to snuff.

Problem: binary uses default Tauri icon set under src-tauri/icons/ + AppIcon.appiconset — not real Bouncy Blobs mark.

YOU OWN (binary + ship):
1. Coordinate with UI for approved master → marketing/app-store/icon-1024.png (or run skill yourself if UI provides path)
2. Wire icons into binary:
   - npx tauri icon <approved-1024.png>  (or skill without --skip-tauri-icon)
   - Confirm src-tauri/icons/* and gen/apple Assets AppIcon.appiconset update
   - LaunchLogo if still generic — align with brand if cheap
3. Bundle soft-platform P1 (already code-complete) in this same build
4. Bump CFBundleVersion (e.g. 2.0.0.2 via sync-version --build / IOS_BUILD) — marketing can stay 2.0.0
5. npm run ios:build + npm run ios:upload (Tankii ASC key OK)
6. Project chat: new Delivery UUID + confirm icon visible in archive

ACCEPT:
- IPA not using default Tauri mark
- Build number > previous upload
- Soft-platform fix included
- Status when TF processing

Do not wait on full store screenshots.
