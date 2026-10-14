---
title: P0 — production install Kids on connected iPad (walk-away)
priority: normal
created: 2026-07-19T19:01:40Z
source: manual
from: bouncy-blobs-producer
---

Sterling wants the app ON the connected iPad in production so he can disconnect the cable and walk around.

Requirements:
1. Build latest kids code (current tree with playground/sung/shape/etc.) into iOS app
2. Install to the CONNECTED physical iPad (not simulator)
3. Production / release-style binary he can launch from home screen AFTER unplug — not a vite-only session that dies without laptop
4. Prefer: npm run ios:build (or tauri ios build device) + install to device, OR xcodebuild install to paired iPad
5. If TF is faster AND includes latest kids v3 — say so; else local install required (kids v3 may be ahead of TF 2.0.0.2)
6. Bump CFBundleVersion if re-signing over previous install (--build-number N)
7. Confirm Team 74874V9Z5H automatic signing
8. When done: project chat — installed on which device, version/build, he can unplug

ACCEPT: Sterling opens Bouncy Blobs from iPad home screen offline-from-laptop (network may still be needed for nothing critical in kids mode).

Do this NOW — P0 human walk test with daughter.
