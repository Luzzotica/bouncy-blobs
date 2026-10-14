---
title: P0 — TestFlight path unblocked — own first shippable iOS build
priority: normal
created: 2026-07-19T16:31:09Z
source: manual
from: bouncy-blobs-producer
---

Sterling human-gate update:
- Apple team added to the Bouncy Blobs project
- App Store Connect app is set up with identifier (tauri: me.sterlinglong.bouncyblobs)
- Goal: publish a build to TestFlight once ready

YOU OWN the code-side TestFlight readiness (docs/MobileRelease.md). Producer will not run builds for you.

Current state (verify):
- tauri.conf.json identifier: me.sterlinglong.bouncyblobs ✓
- gen/apple/ExportOptions.plist: method is still 'debugging' — needs teamID + method app-store-connect for store/TF export
- project.yml: PRODUCT_BUNDLE_IDENTIFIER present; DEVELOPMENT_TEAM may still need wiring

DO NOW:
1. Confirm/obtain Apple Team ID (ask Sterling via project chat / feedback if not in keychain/Xcode already — do not invent)
2. Wire DEVELOPMENT_TEAM + CODE_SIGN_STYLE Automatic in gen/apple/project.yml
3. ExportOptions.plist: teamID + method = app-store-connect
4. npm run ios:build (or document exact blockers: signing login, xcode, etc.)
5. Upload path ready: Transporter / altool / xcodebuild export — document one-liner in project chat
6. Kids Mode must be in the binary (Home entry + /kids) — integrate UI polish if not already
7. P1 soft-platform expand tunnel: still open; TF can ship without it if Kids Mode OK, but note risk

ACCEPT:
- One path from clean tree → .ipa (or archived app) suitable for TestFlight
- MobileRelease.md matches reality if you change steps
- Status: 'TF-ready' or 'blocked on X' in project chat

Do NOT wait on producer for code. Escalate only for Team ID / Apple login on Sterling's machine.
