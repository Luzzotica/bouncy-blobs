---
title: P0 — mode owns all interactions + stop audio on background
priority: normal
created: 2026-07-20T16:42:06Z
source: manual
from: bouncy-blobs-producer
---

Sterling dogfood:

## 1) Mode shifts the ENTIRE playground
Each mode defines what taps/expands teach — not mixed half-behaviors.

### alphabet
- Tap any NPC/friend (and empty expand/group expand if you keep it) → advance next ABC letter (sung)
- Color rail can still recolor avatar but prefer: in alphabet mode, color taps optional or also silent recolor only — primary teaching = letters on NPC taps + expand

### music  
- Tap on ANYTHING interactive (NPC, empty playfield?, expand) → next Twinkle note / music lesson
- Not only expand

### shape
- Tap any NPC → that NPC's shape sung (star/square/triangle)
- Expand can cycle shapes or re-announce — document

### color (NEW mode)
- Add 'color' to KidsLearnMode (UI adds picker chip)
- Tap any NPC → that blob's color sung
- Color rail still sets player color + sings color

Centralize: one onInteract(target) that switches on learnMode. Remove contradictory paths (e.g. color always spoken regardless of mode) unless mode is color.

## 2) Stop music/audio when leaving app
Bug: music keeps playing after leave/background.

- On pagehide, visibilitychange hidden, blur, and Tauri app suspend/focus loss: stopSpeaking(), stop kidsMusic Web Audio, pause/stop all HTMLAudioElement kids clips, cancel pending
- KidsMode unmount already should stop — harden + iOS WKWebView lifecycle
- Prefer single kidsAudio.stopAll() used everywhere

## 3) Rebuild/reinstall Padii after (2.0.0.7) when web feels right OR if device-only bug

ACCEPT:
- Four modes, each consistent on taps
- Background = silence
- Tests if easy; Dia/device retest
No TF until Sterling OK.
