---
title: P0 — immersive gaming mode + bottom controls + reinstall Padii
priority: normal
created: 2026-07-19T19:09:29Z
source: manual
from: bouncy-blobs-producer
---

Sterling dogfood on Padii walk-away app:

## 1) Gaming / immersive mode
- Hide iOS status bar (time, battery, etc.) while in game / Kids Mode — fullscreen immersive
- Info.plist / tauri / UIViewController prefersStatusBarHidden, UIStatusBarHidden, edges under status bar
- Match 'gaming mode' feel: no system chrome at top

## 2) Bottom controls layout (with UI)
- Color rail at bottom BETWEEN joystick (left) and puff (right)
- Both stick and puff at bottom of screen (safe area home indicator)
- Color bar was pushed up on device — fix root cause (safe-area, pad height, rail top offset)

## 3) Landscape lock if not already shipped

## 4) Rebuild + install Padii
- Bump CFBundleVersion e.g. 2.0.0.5
- Install walk-away production like 2.0.0.4
- Report when home screen ready

ACCEPT: no status bar in kids play; bottom bar = [joystick | colors | puff] all bottom-aligned.
