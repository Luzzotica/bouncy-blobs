---
title: P0 polish — shapes, phonetics, map, notes, AI expand
priority: normal
created: 2026-07-19T18:38:06Z
source: manual
from: bouncy-blobs-producer
---

Sterling screenshot feedback (Dia kids playground):

## 1) More bottom space to see shapes
- UI removes face row; you free camera/layout if dock still covers blobs (safe padding above dock, camera bounds account for chrome height)

## 2) Decrease bezier rounding on shapes
- Square/triangle (and star if needed) must read clearly — reduce hull/render smoothing / blob roundedness for non-circle hullPresets in kids mode so square looks square, triangle looks triangle
- Look at slimeBlob hull or kids render path

## 3) Face change — UI removes; strip any face-only kids code if orphaned (keep color)

## 4) Phonetic letter regen (ONLY these — others good)
A E H P U Y sound wrong when sung as single letter.
- Update generate-kids-voice.py: for these letters use phonetic sung syllables (e.g. "Ay", "Ee", "Aitch" or "Hay", "Pee", "Yoo", "Why" — pick clearest preschool sung forms)
- Force regen ONLY letter-a, letter-e, letter-h, letter-p, letter-u, letter-y
- Spot-listen before handoff

## 5) Music note VFX
- Spawn more randomly around player (spread offset), not stacked on centroid

## 6) Kids map: remove bottom two platforms
- public/levels/kids-playground.json — delete the two lowest/bottom platforms that feel claustrophobic
- Keep closed box + full-view camera

## 7) NPCs expand like game AIs
- Friend AI should sometimes expand (puff) on their own like multiplayer/AI expand behavior — not only when Space hits everyone
- Still tappable; Space still expands all + one lesson

ACCEPT: Dia-ready; tsc clean; no TF until Sterling OK
