#!/usr/bin/env bash
# Build "Bouncy Blobs.app" (universal arm64 + x86_64) into build/macos/.
#   scripts/build-macos.sh          # build
#   scripts/build-macos.sh --run    # build, then launch the bundle
#   scripts/build-macos.sh --zip    # also produce build/macos/BouncyBlobs-<ver>-macos.zip
#   ARCHS=aarch64-apple-darwin scripts/build-macos.sh   # one arch (quick test builds)
# Signing: ad-hoc by default. Set MACOS_SIGN_IDENTITY="Developer ID Application: …"
# to sign for distribution (notarize with `xcrun notarytool submit`).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
source "$ROOT/scripts/lib/mp-api-key.sh"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"

RUN=0; ZIP=0
for a in "$@"; do
  case "$a" in --run) RUN=1 ;; --zip) ZIP=1 ;; *) echo "unknown arg $a" >&2; exit 2 ;; esac
done

VERSION="$(awk -F'"' '/^\[workspace.package\]/{f=1} f&&/^version/{print $2; exit}' Cargo.toml)"
BUILD="${MACOS_BUILD_NUMBER:-$VERSION}"

ARCHS="${ARCHS:-aarch64-apple-darwin x86_64-apple-darwin}"
BINS=()
for t in $ARCHS; do
  rustup target add "$t" >/dev/null 2>&1 || true
  cargo build --release --target "$t" -p bb-game --bin bouncy-blobs
  BINS+=("$TARGET_DIR/$t/release/bouncy-blobs")
done

APP="$ROOT/build/macos/Bouncy Blobs.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create -output "$APP/Contents/MacOS/bouncy-blobs" "${BINS[@]}"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" macos/Info.plist > "$APP/Contents/Info.plist"
cp macos/BouncyBlobs.icns "$APP/Contents/Resources/"
# bb_game::platform looks in Contents/Resources/assets when bundled.
cp -R crates/bb-game/assets "$APP/Contents/Resources/assets"
printf 'APPL????' > "$APP/Contents/PkgInfo"

codesign --force --deep --options runtime --sign "${MACOS_SIGN_IDENTITY:--}" "$APP"
lipo -info "$APP/Contents/MacOS/bouncy-blobs"
echo "built $APP ($VERSION / $BUILD)"

if [[ $ZIP == 1 ]]; then
  ditto -c -k --keepParent "$APP" "$ROOT/build/macos/BouncyBlobs-$VERSION-macos.zip"
fi
if [[ $RUN == 1 ]]; then
  "$APP/Contents/MacOS/bouncy-blobs"
fi
