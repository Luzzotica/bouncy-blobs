---
title: P0 — Kids voice via ElevenLabs + ABC on expand + mode switcher
priority: normal
created: 2026-07-19T17:09:09Z
source: manual
from: bouncy-blobs-producer
---

Sterling playtest feedback (Dia). Ship on web first; TF rebuild after green.

## 1) ElevenLabs sounds (replace Web Speech for kids)

Built-in TTS is SUPER bad. Generate + BUNDLE short clips offline (no runtime ElevenLabs API in kids loop).

Generate with monorepo tooling (scripts/.env ELEVENLABS_API_KEY):
- Voice clips: colors (Red, Orange, Yellow, Green, Teal, Blue, Purple, Pink, White, … match colorNames)
- Letters A–Z (clear kid-friendly voice, short)
- Optional: welcome "Let's bounce!" if still used
- Prefer existing scripts patterns: generate_sfx.py / generate_intro_assets.py style; put under public/sfx/kids/ or public/kids-voice/
- Runtime: speak() / kids audio helper plays HTMLAudioElement clips by key; cancel/duck previous; NO speechSynthesis for colors/ABC
- Web Speech only as last-resort fallback if clip missing (or omit fallback if Sterling hates it — prefer silent miss + log)

Document regen one-liner in docs or scripts/README for kids voice pack.

## 2) ABC rule CHANGE

OLD: letter on land bounce.
NEW: speak/play NEXT letter only when PLAYER expands (rising edge of expand on kids-player) — puff button / expand input edge.
Update kidsAbc.ts header + any tests. Debounce still OK so held expand doesn't spam.

## 3) Modes (experiment, keep simple)

Mode state on Kids Mode (local, no multiplayer):

### Alphabet mode (default)
- Expand → next letter A…Z cycle (clips)
- Color pick → color name clip
- Blob pick-up → color name clip

### Music mode
- Expand → play next note/phrase of a simple nursery melody (start with Twinkle Twinkle Little Star)
- Options: ElevenLabs Music short instrumental notes OR pre-generated note clips / sequenced tones in public/sfx/kids/music/twinkle/
- Prefer short one-shot notes that advance sequence on each expand (fun for toddlers)
- Color pick / blob pick can still soft-speak color OR soft ding — pick one simple rule and document (recommend keep color names so colors still teach)

Scaffold so more modes can be added later (enum + switch). UI will provide mode picker chips.

## 4) Coordinate UI

UI moves color rail to bottom full-width smaller. Keep speech/pointer paths intact.
Wire mode toggle they ship (or stub data-testid kids-mode-alphabet / kids-mode-music).

## ACCEPT
- No Web Speech for happy path colors/ABC
- Expand (not land) advances alphabet in Alphabet mode
- Music mode expand advances Twinkle sequence
- Color rail bottom (after UI)
- npm run dev playable; tests updated for ABC rule
- Status project chat when ready for Sterling re-test in Dia

Do NOT re-TF until Sterling likes web feel.
