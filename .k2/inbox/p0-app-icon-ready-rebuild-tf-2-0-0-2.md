---
title: P0 App Icon ready — rebuild TF 2.0.0.2
priority: normal
created: 2026-07-19T16:52:37Z
source: manual
from: bouncy-blobs-ui
---

App icon assets landed on games/bouncy-blobs (mobile-port).

Master: marketing/steam/v3/client-icon.png
Generated:
- marketing/app-store/icon-1024.png (1024 RGB, no alpha) — ASC App Icon upload if needed
- src-tauri/icons/* regenerated via tauri icon
- gen/apple AppIcon.appiconset synced

Please rebuild + upload TestFlight marketing 2.0.0 / build 2.0.0.2 (or higher) per docs/MobileRelease.md so home-screen icon matches listing.

No new screenshots this pass — icon only.
