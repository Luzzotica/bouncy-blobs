#!/usr/bin/env bash
# Build bouncy-blobs and publish the web build to itch.io via butler.
#
# Usage:
#   ./scripts/publish-itch.sh            # build + zip + push
#   ./scripts/publish-itch.sh --wasm     # also rebuild the Rust/wasm softbody crate
#   ./scripts/publish-itch.sh --no-push  # build + zip only (skip butler push)
#   ./scripts/publish-itch.sh --dry-run  # show what would happen
#
# Requires: butler on PATH, logged in (`butler login`).

set -euo pipefail

ITCH_TARGET="luzzotica/bouncy-blobs:html5"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD_WASM=0
DO_PUSH=1
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --wasm) BUILD_WASM=1 ;;
    --no-push) DO_PUSH=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
ZIP_PATH="$ROOT/dist-itch-${VERSION}.zip"

run() {
  echo "+ $*"
  if [[ $DRY_RUN -eq 0 ]]; then "$@"; fi
}

if [[ $BUILD_WASM -eq 1 ]]; then
  run npm run build:wasm
fi

# Vite loads .env.local and .env.production.local on top of .env, which
# would override our prod keys with dev/local ones. For itch we want
# ONLY .env, so move the .local files aside for the duration of the build.
STASHED=()
stash_env() {
  for f in .env.local .env.production.local .env.development.local; do
    if [[ -f "$ROOT/$f" ]]; then
      mv "$ROOT/$f" "$ROOT/$f.itch-bak"
      STASHED+=("$f")
      echo "stashed $f"
    fi
  done
}
restore_env() {
  for f in "${STASHED[@]:-}"; do
    [[ -z "$f" ]] && continue
    [[ -f "$ROOT/$f.itch-bak" ]] && mv "$ROOT/$f.itch-bak" "$ROOT/$f" && echo "restored $f"
  done
}
trap restore_env EXIT
if [[ $DRY_RUN -eq 0 ]]; then stash_env; fi

ITCH_BUILD=1 run npm run build

if [[ ! -f "$ROOT/dist/index.html" ]]; then
  echo "error: dist/index.html missing after build" >&2
  exit 1
fi

# Zip from inside dist/ so index.html is at the archive root (itch requirement).
rm -f "$ZIP_PATH"
run bash -c "cd '$ROOT/dist' && zip -r -q '$ZIP_PATH' ."
echo "zip: $ZIP_PATH ($(du -h "$ZIP_PATH" 2>/dev/null | cut -f1))"

if [[ $DO_PUSH -eq 1 ]]; then
  run butler push "$ZIP_PATH" "$ITCH_TARGET" --userversion "$VERSION"
  echo "pushed $ITCH_TARGET @ $VERSION"
  echo "check status with: butler status $ITCH_TARGET"
else
  echo "skipped butler push (--no-push)"
fi
