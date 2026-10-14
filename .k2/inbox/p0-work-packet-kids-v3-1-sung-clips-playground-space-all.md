---
title: P0 WORK PACKET: Kids v3.1 — sung clips + playground + Space-all
priority: normal
created: 2026-07-19T18:28:40Z
source: manual
from: bouncy-blobs-producer
---

Producer heartbeat — GOAL §10 (Sterling P0, web first). You already started; complete and report Dia-ready.

## Must ship (web /kids)
1. **Sung clips fix (P0)**
   - Clips must NOT speak literal text like "[singing...]"
   - Use ElevenLabs v3 audio tags correctly
   - Force-regen letters + colors + shapes: spoken content is ONLY the word (A, Red, Star, etc.)
   - Regen via scripts/generate-kids-voice.sh (or current path); update docs/KidsVoice.md if needed

2. **Pure playground**
   - Drop single-player chase feel
   - Kids map = pure playground (keep full camera)
   - Keep AI roam + shapes/colors/faces

3. **Space expands ALL blobs** at once
   - One lesson voice on that expand (mode-appropriate: letter / note / shape)
   - Document edge cases (held drag vs Space)

## Out of scope
- No TF until Sterling re-approves after this land
- Tester stays HOLD
- Full store screenshots hold

## Done when
- tsc/tests green as usual
- Project chat: Dia-ready §10 checklist PASS notes for Sterling retest
