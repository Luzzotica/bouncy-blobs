#!/usr/bin/env python3
"""Generate bundled Kids Mode voice clips via ElevenLabs TTS.

Outputs land in public/sfx/kids/:
  letter-a.mp3 … letter-z.mp3
  color-red.mp3 … (unique palette names)
  shape-star.mp3, shape-square.mp3, shape-triangle.mp3

Idempotent: skips existing files unless --force.

Usage (from bouncy-blobs/):
  ../scripts/.venv/bin/python scripts/generate-kids-voice.py
  ../scripts/.venv/bin/python scripts/generate-kids-voice.py --force
  ../scripts/.venv/bin/python scripts/generate-kids-voice.py letter-a color-red

Requires: games/scripts/.env with ELEVENLABS_API_KEY

Kids v3 audio:
  - Spoken text is ONLY the word (A / Red / Star) — never "Singing…"
  - Musical delivery via Eleven v3 audio tags (not read aloud) + style settings
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from elevenlabs.types.voice_settings import VoiceSettings

SCRIPT_DIR = Path(__file__).resolve().parent
BB_ROOT = SCRIPT_DIR.parent
REPO_ROOT = BB_ROOT.parent
OUT_DIR = BB_ROOT / "public" / "sfx" / "kids"

# Monorepo scripts/.env
load_dotenv(REPO_ROOT / "scripts" / ".env")
load_dotenv(SCRIPT_DIR / ".env")

# Jessica — Playful, Bright, Warm (good for preschoolers)
DEFAULT_VOICE_ID = "cgSgspJ2msm6clMCkdW9"
# Multilingual v2 + bare word text (A! / Red! / Star!). No prose tags —
# older " [singing …] " prompts were read aloud as "Singing…". Style settings
# carry the sung/expressive delivery instead.
DEFAULT_MODEL = "eleven_multilingual_v2"
FALLBACK_MODEL = "eleven_multilingual_v2"

# Unique spoken color names (matches colorNames.ts unique set)
COLORS = [
    "Red",
    "Orange",
    "Yellow",
    "Green",
    "Teal",
    "Blue",
    "Purple",
    "Pink",
    "White",
]

LETTERS = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
SHAPES = ["Star", "Square", "Triangle"]


def slug(s: str) -> str:
    return s.strip().lower().replace(" ", "-")


# Letter-name phonetics — clear English letter names (not short vowel sounds).
# Spelled so multilingual TTS lands on /eɪ/ /iː/ /eɪtʃ/ /piː/ /juː/ /waɪ/.
PHONETIC_LETTERS: dict[str, str] = {
    "A": "Ay",
    "E": "Ee",
    "H": "Aitch",
    "P": "Pee",
    "U": "Yoo",
    "Y": "Wye",
}


def clip_jobs(*, plain: bool = True) -> list[tuple[str, str]]:
    """Return (filename_stem, spoken_text) pairs.

    Spoken content is ONLY the kid word (A! / Red! / Star!) — never bracket
    tags or prose like 'Singing a clear musical note…'. Ambiguous letters use
    phonetic letter-names (Ay / Ee / Aitch / Pee / You / Why).
    """
    del plain  # always bare words (kept for CLI compat)
    jobs: list[tuple[str, str]] = []
    for L in LETTERS:
        jobs.append((f"letter-{L.lower()}", PHONETIC_LETTERS.get(L, f"{L}!")))
    for c in COLORS:
        jobs.append((f"color-{slug(c)}", f"{c}!"))
    for s in SHAPES:
        jobs.append((f"shape-{slug(s)}", f"{s}!"))
    return jobs


def generate_one(
    client: ElevenLabs,
    voice_id: str,
    model_id: str,
    stem: str,
    text: str,
    *,
    force: bool,
) -> Path:
    out = OUT_DIR / f"{stem}.mp3"
    if out.exists() and not force:
        print(f"  skip {out.name} (exists)")
        return out

    print(f"  gen  {out.name} ← {text!r}  [{model_id}]")
    audio = client.text_to_speech.convert(
        voice_id=voice_id,
        text=text,
        model_id=model_id,
        output_format="mp3_44100_128",
        voice_settings=VoiceSettings(
            stability=0.35,
            similarity_boost=0.75,
            style=0.7,  # expressive / musical for sung kids words
            use_speaker_boost=True,
        ),
    )
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as f:
        for chunk in audio:
            if chunk:
                f.write(chunk)
    print(f"  ✓    {out.name} ({out.stat().st_size} bytes)")
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="Generate Kids Mode ElevenLabs TTS pack")
    p.add_argument("--force", action="store_true", help="Regenerate even if file exists")
    p.add_argument("--voice-id", default=os.environ.get("KIDS_VOICE_ID", DEFAULT_VOICE_ID))
    p.add_argument("--model-id", default=os.environ.get("KIDS_VOICE_MODEL", DEFAULT_MODEL))
    p.add_argument(
        "--plain",
        action="store_true",
        help="No v3 tags — text is bare 'A!' / 'Red!' / 'Star!' (for non-v3 models)",
    )
    p.add_argument("only", nargs="*", help="Optional stems e.g. letter-a color-red")
    args = p.parse_args()

    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise SystemExit("ELEVENLABS_API_KEY not set (games/scripts/.env)")

    jobs = clip_jobs(plain=args.plain)
    if args.only:
        wanted = set(args.only)
        jobs = [(s, t) for s, t in jobs if s in wanted]
        missing = wanted - {s for s, _ in jobs}
        if missing:
            raise SystemExit(f"unknown stems: {sorted(missing)}")

    client = ElevenLabs(api_key=api_key)
    model_id = args.model_id
    print(f"Kids voice pack → {OUT_DIR}")
    print(f"voice={args.voice_id} model={model_id} force={args.force} plain={args.plain}")

    # Probe model once; fall back if v3 is rejected.
    if jobs:
        try:
            generate_one(
                client, args.voice_id, model_id, jobs[0][0], jobs[0][1], force=args.force,
            )
            rest = jobs[1:]
        except Exception as e:
            if model_id != FALLBACK_MODEL:
                print(f"  ! model {model_id} failed ({e}); falling back to {FALLBACK_MODEL} + plain text")
                model_id = FALLBACK_MODEL
                # Multilingual v2 reads bracket tags aloud — bare words only.
                jobs = clip_jobs(plain=True)
                if args.only:
                    wanted = set(args.only)
                    jobs = [(s, t) for s, t in jobs if s in wanted]
                rest = jobs
            else:
                raise
        for stem, text in rest:
            generate_one(client, args.voice_id, model_id, stem, text, force=args.force)
    print("done.")


if __name__ == "__main__":
    main()
