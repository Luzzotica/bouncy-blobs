---
title: P0 Kids v3 — sing, side-move, kids map, shape mode, faces, AI friends
priority: normal
created: 2026-07-19T17:50:16Z
source: manual
from: bouncy-blobs-producer
---

Sterling loves the direction. Web first; no TF until he approves.

## 1) SING the ABCs and colors (ElevenLabs)
- Regen letter A–Z clips as SUNG syllables (kid musical, clear pitch per letter — not spoken)
- Regen color name clips as SUNG too
- Update generate-kids-voice.sh prompts; replace public/sfx/kids/*.mp3
- Shape names too when Shape mode lands: Star, Square, Triangle (sung or clear sung-ish)

## 2) Side-tap to move (iPad kids)
- Empty canvas tap (not on blob, not on UI chrome): left half → move left, right half → move right
- Hold/drag edge or continuous input while finger held preferred for toddlers
- Don't steal color rail / mode picker / face row / pad hits
- Merge with keyboard/pad if any

## 3) Custom kids map + whole-level camera
- STOP using default level only
- Author kids-friendly map (soft platforms, safe, few/no spikes): e.g. public/levels/kids-playground.json + manifest
- Camera shows WHOLE playfield (static fit / zoom out like sandbox static fit) — kid sees entire space
- Document level id in KidsMode

## 4) Shape mode
- New KidsLearnMode: 'shape' alongside alphabet | music
- Friend blobs use distinct hullPresets: star, square, triangle (cycle)
- Tap friend → speak/sing SHAPE name (not color) when mode=shape
- Expand player behavior: decide simple rule (e.g. still letter in alphabet only; shape mode expand can soft ding or cycle shape names — document)

## 5) Face change (daughter loves this)
- UI adds second row of faces under colors; you wire setPlayerFaceIdSetting + live managed.faceId
- Friends can keep default or random faces

## 6) AI friends moving
- Friends/NPCs should wander/move with AI (existing aiController patterns or simple wander)
- Still tappable to expand + announce color/shape per mode
- Don't make them un-grabbable

## ACCEPT
- Sung letters on expand (alphabet)
- Sung colors on color pick
- Side-tap/hold moves blob
- Custom kids map full view
- Shape mode works with star/square/triangle friends
- Face row changes player face live
- Friends roam with AI
- Dia-ready status; tests as needed
No TF until Sterling greenlights.
