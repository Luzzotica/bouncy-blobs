#!/usr/bin/env bash
# Generate every gameplay & UI sound effect for Bouncy Blobs via ElevenLabs.
# Idempotent: skips files that already exist unless --force is passed.
#
# Usage:
#   ./scripts/generate-all-sfx.sh                # generate missing only
#   ./scripts/generate-all-sfx.sh --force        # regenerate everything
#   ./scripts/generate-all-sfx.sh land-squelch-1 # generate just one (matches keys below)
#
# Requires: scripts/.env at repo root with ELEVENLABS_API_KEY, plus
# `python -m pip install -r scripts/requirements.txt` from repo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BB_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BB_ROOT/.." && pwd)"
GEN_PY="$REPO_ROOT/scripts/generate_sfx.py"
OUT_DIR="$BB_ROOT/public/sfx"

# Prefer a virtualenv at scripts/.venv if present (mac Homebrew Python is
# externally-managed, so the bootstrap is `python3 -m venv scripts/.venv &&
# scripts/.venv/bin/pip install -r scripts/requirements.txt`).
if [[ -x "$REPO_ROOT/scripts/.venv/bin/python" ]]; then
  PYTHON="$REPO_ROOT/scripts/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
else
  PYTHON="python"
fi

mkdir -p "$OUT_DIR"

if [[ ! -f "$GEN_PY" ]]; then
  echo "error: $GEN_PY not found" >&2
  exit 1
fi

FORCE=0
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) ONLY="$arg" ;;
  esac
done

# (filename, prompt, duration-seconds, prompt-influence)
# ElevenLabs requires duration >= 0.5s. Influence ~0.6-0.8 keeps prompts on-brief.
SFX=(
  # — Landing: single sound; pitch jitter at playback gives the variety.
  #   Prompt deliberately avoids "splat" / "crack" / "slap" — those make
  #   ElevenLabs return metallic-sounding impacts. The goal is dull, damp,
  #   low-frequency fabric on wood, with audible water content.
  "land-squelch.mp3|sound effect of a bare hand covered in thick gooey slime smacking flat against a hard wooden table, single short wet smack, sloppy gooey impact with audible slimy peel-off afterward, organic squishy, close-mic dry, mid-range, no sub-bass thud, no metallic ring, no music, no reverb|0.7|0.92"

  # — Puff up: the user recorded their own variants (puff-up-1/-2/-3.mp3).
  #   Don't regenerate over them; this entry stays commented as historical
  #   reference for what we tried before the recordings landed.
  # "puff-up.mp3|sharp short hissing inhale sucking air through pursed wet lips, audible fast rush of air being drawn into the mouth, dominant airflow sound with a faint moist lip texture, single quick gasp, close-mic, no slurping, no licking, no tongue sounds, no swallowing, no music|0.5|0.9"

  # — Sticky wall —
  "wall-stick.mp3|sticky goo grab, suction stick to surface, short wet thwip, no music|0.5|0.8"
  "wall-jump.mp3|wet unstick pop with quick swoosh launch, cartoon, no music|0.5|0.8"

  # — Spring pad —
  "spring-boing.mp3|cartoon spring boing launch, single bouncy twang, no music|0.6|0.8"

  # — Spike death —
  "spike-splat.mp3|comedic squish pop death, exaggerated cartoon splat with brief squeal, no music|0.8|0.8"

  # — Powerup pickup —
  "powerup-sparkle.mp3|magical sparkle pickup chime, bright shimmer, short and rewarding, no music|0.7|0.7"

  # — Countdown / round flow —
  "countdown-tick.mp3|short rising countdown blip, single tick, clean synth, no music|0.5|0.7"
  "countdown-go.mp3|short upbeat go fanfare blip, bright stinger, no music|0.6|0.7"
  "round-win.mp3|short victory sting, triumphant cartoon fanfare, ends clean, no music bed|1.6|0.7"

  # — UI —
  "ui-hover.mp3|sound effect of one paperstock playing card sliding out from a stack of cards, short soft paper-on-paper slide whisper, close-mic dry, no music|0.5|0.85"
  "ui-click.mp3|crisp UI button click pop, snappy, no music|0.5|0.75"
  "ui-confirm.mp3|short bright UI confirm chime, two-note positive, no music|0.5|0.7"
  "ui-modal-open.mp3|short whoosh-in UI panel open, paper rip-on, playful, no music|0.5|0.75"
  "ui-modal-close.mp3|short whoosh-out UI panel close, paper rip-off, playful, no music|0.5|0.75"
)

generated=0
skipped=0
for entry in "${SFX[@]}"; do
  IFS='|' read -r name prompt dur infl <<< "$entry"

  if [[ -n "$ONLY" && "${name%.mp3}" != "$ONLY" ]]; then
    continue
  fi

  out="$OUT_DIR/$name"
  if [[ -f "$out" && $FORCE -eq 0 ]]; then
    echo "  · skip (exists): $name"
    skipped=$((skipped + 1))
    continue
  fi

  echo "  → $name :: $prompt"
  "$PYTHON" "$GEN_PY" \
    "$prompt" \
    "$OUT_DIR" \
    "$name" \
    --duration-seconds "$dur" \
    --prompt-influence "$infl"
  generated=$((generated + 1))
done

echo ""
echo "✓ done. generated=$generated  skipped=$skipped  out=$OUT_DIR"
