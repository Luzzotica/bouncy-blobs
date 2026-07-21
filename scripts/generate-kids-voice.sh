#!/usr/bin/env bash
# Generate bundled Kids Mode voice clips (ElevenLabs TTS).
# See scripts/generate-kids-voice.py and docs note in GOAL / MobileRelease.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BB_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BB_ROOT/.." && pwd)"

if [[ -x "$REPO_ROOT/scripts/.venv/bin/python" ]]; then
  PYTHON="$REPO_ROOT/scripts/.venv/bin/python"
else
  PYTHON="python3"
fi

exec "$PYTHON" "$SCRIPT_DIR/generate-kids-voice.py" "$@"
