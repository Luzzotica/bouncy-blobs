#!/usr/bin/env bash
# Build Bouncy Blobs for the web (wasm32 + wasm-bindgen + WebGL2) into web/dist.
#   scripts/web-build.sh            # release
#   scripts/web-build.sh --dev      # faster, unoptimised
#   scripts/web-build.sh --serve    # build, then serve on http://localhost:8080
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"

PROFILE=release; CARGO_FLAGS="--release"; SERVE=0
for a in "$@"; do
  case "$a" in
    --dev) PROFILE=debug; CARGO_FLAGS="" ;;
    --serve) SERVE=1 ;;
    *) echo "unknown arg $a" >&2; exit 2 ;;
  esac
done

TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
OUT="$ROOT/web/dist"

# wasm-bindgen CLI must match the wasm-bindgen crate version in Cargo.lock.
WB_VER="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = |"/,""); print; exit}' Cargo.lock)"
WB="wasm-bindgen"
if ! command -v wasm-bindgen >/dev/null || [[ "$(wasm-bindgen --version | awk '{print $2}')" != "$WB_VER" ]]; then
  WB="$TARGET_DIR/tools/wasm-bindgen-$WB_VER/bin/wasm-bindgen"
  if [[ ! -x "$WB" ]]; then
    echo "Installing wasm-bindgen-cli $WB_VER into $TARGET_DIR/tools ..."
    cargo install wasm-bindgen-cli --version "$WB_VER" --locked --root "$TARGET_DIR/tools/wasm-bindgen-$WB_VER"
  fi
fi

rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo build $CARGO_FLAGS --target wasm32-unknown-unknown -p bb-game --bin bouncy-blobs

rm -rf "$OUT"; mkdir -p "$OUT"
"$WB" --target web --no-typescript --out-dir "$OUT" --out-name bouncy-blobs \
  "$TARGET_DIR/wasm32-unknown-unknown/$PROFILE/bouncy-blobs.wasm"

if [[ "$PROFILE" == release ]] && command -v wasm-opt >/dev/null; then
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int \
    -o "$OUT/bouncy-blobs_bg.wasm" "$OUT/bouncy-blobs_bg.wasm"
fi

cp web/index.html web/icon.png "$OUT/"
# Bevy fetches assets relative to the page: ./assets/<path>
cp -R crates/bb-game/assets "$OUT/assets"
echo "web build -> $OUT ($(du -sh "$OUT" | cut -f1))"

if [[ $SERVE == 1 ]]; then
  echo "serving http://localhost:8080"
  cd "$OUT" && python3 -m http.server 8080
fi
