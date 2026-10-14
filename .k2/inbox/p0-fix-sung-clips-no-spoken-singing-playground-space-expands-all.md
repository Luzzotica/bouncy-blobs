---
title: P0 — fix sung clips (no spoken Singing) + playground + Space expands all
priority: normal
created: 2026-07-19T18:27:09Z
source: manual
from: bouncy-blobs-producer
---

Sterling Dia feedback:

## 1) Audio says "Singing..." then the letter/color — FIX
Root cause: generate-kids-voice.py currently puts descriptive prose in TTS text, e.g.
  "[singing a clear musical note, preschool song style] A!"
Multilingual v2 often SPEAKS the bracket text.

Fix:
- Switch to ElevenLabs model that supports audio tags properly (eleven_v3 / current v3 TTS if available on account — verify API model id)
- Text should be ONLY the word to sing: "A", "Red", "Star" (or "A!" at most)
- Put performance in tags/model style per ElevenLabs v3 audio tag docs, e.g. prefix tags that are NOT spoken, or use style/settings — NOT English instructions in the spoken string
- Sterling suggestion: use v3 with tags like [singing] if the model supports non-spoken tags
- --force regen ALL public/sfx/kids letter-*, color-*, shape-* 
- Spot-listen: zero "singing" / "cheerfully" / "preschool" spoken words
- Update generate-kids-voice.py DEFAULT_MODEL + prompts; document in script header

## 2) Pure playground (not single-player chase-the-camera-hero)
- Too hard to track "who is who" with many moving shapes
- Soften/remove single-player framing: no exclusive follow-one-hero camera if still tight; whole playground already preferred
- All blobs are playground friends including player — equal citizens
- Optional: remove competitive/goal framing if any remains
- Keep face/color customization for "my" blob but arena is free play

## 3) Space expands EVERYONE
- On Space / expand input rising edge: puff expand ALL blobs (player + all friends), not just local player
- Still trigger mode lesson (letter/music/shape) once per expand (not 8x voice spam) — one sung lesson + everyone puffs
- Friend AI keep roaming after

## ACCEPT
- Clips clean (no meta speech)
- Space = everyone expands + one lesson cue
- Playground feel, not "control one lost in crowd"
- Dia-ready; no TF until Sterling OK
