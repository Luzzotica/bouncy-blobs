#!/usr/bin/env bash
# Generate every in-game sprite for Bouncy Blobs via OpenAI Images.
# Idempotent: skips PNGs that already exist unless --force is passed.
# Always re-runs the manifest update step so collision shapes stay in sync
# with the current art_manifest.py.
#
# Usage:
#   ./scripts/generate-all-art.sh                     # generate missing only
#   ./scripts/generate-all-art.sh --force             # regenerate every PNG
#   ./scripts/generate-all-art.sh spring_pad          # one asset by id
#   ./scripts/generate-all-art.sh --manifest-only     # don't touch images
#
# Requires: scripts/.env at repo root with OPENAI_API_KEY, plus
# `python -m pip install -r scripts/requirements.txt` from repo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BB_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BB_ROOT/.." && pwd)"
GEN_PY="$REPO_ROOT/scripts/generate_art.py"

if [[ -x "$REPO_ROOT/scripts/.venv/bin/python" ]]; then
  PYTHON="$REPO_ROOT/scripts/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
else
  PYTHON="python"
fi

if [[ ! -f "$GEN_PY" ]]; then
  echo "error: $GEN_PY not found" >&2
  exit 1
fi

FORCE_ARGS=()
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --force|--manifest-only) FORCE_ARGS+=("$arg") ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) ONLY="$arg" ;;
  esac
done

# List of asset ids — must match ART_ASSETS in scripts/art_manifest.py.
ASSETS=(
  "spring_pad"
  "spike"
  "goal_flag"
  "powerup_orb"
  "pencil"
)

generated=0
for id in "${ASSETS[@]}"; do
  if [[ -n "$ONLY" && "$id" != "$ONLY" ]]; then
    continue
  fi
  echo "→ $id"
  "$PYTHON" "$GEN_PY" "$id" ${FORCE_ARGS[@]+"${FORCE_ARGS[@]}"}
  generated=$((generated + 1))
done

echo ""
echo "✓ done. processed=$generated"
