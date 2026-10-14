---
title: P0 polish — welcome off, louder music, mode VFX, letter cut-off
priority: normal
created: 2026-07-19T17:17:03Z
source: manual
from: bouncy-blobs-producer
---

Sterling Dia feedback on kids web v2:

## 1) Color spacing
UI adds +5px chip gap — integrate if they touch KidsMode layout only.

## 2) Letters cut off
Investigate:
- Visual: letter badge clipping (UI may fix)
- Audio: ElevenLabs A-Z clips truncated (regen with more tail silence / longer duration via generate-kids-voice.sh)
Fix whichever is broken; report which.

## 3) No welcome line
Remove speak/play of welcome / "Let's bounce" / "Let's play" on Kids Mode enter. Silent start — first voice is color or expand.

## 4) Music mode louder + VFX
- Twinkle / music note path: raise gain/volume (noticeably louder, not clipping)
- On expand in Music mode: spawn music-note style effects (particles/floaters) — similar energy to existing slime/goop VFX but notes (♪/♫ or particle shapes)
- On expand in Alphabet mode: letter-flavored effects (not same as slime splat) — e.g. letter burst / sparkle with letter glyph or alphabet confetti
Reuse effectsBindings/particles patterns; keep cheap for mobile.

## ACCEPT
- No auto voice on enter
- Music expand clearly louder + note VFX
- Alphabet expand letter VFX distinct from slime
- Letters fully visible and fully audible
- Status when Dia-ready again

No TF until Sterling approves.
