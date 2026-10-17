#!/usr/bin/env bash
# Assemble one platform's release content (the Steam depot AND what the partii
# zip holds: one full download per platform). Copied from
# tankii-worlds/scripts/steam/assemble-native.sh.
#
#   scripts/steam/assemble.sh <macos|windows|linux> <build> [out-dir]
#
#   build    macos    "Bouncy Blobs.app" (scripts/build-macos.sh --steam)
#            windows  bouncy-blobs.exe   (Luzz box: cargo xwin … --features steam)
#            linux    bouncy-blobs       (Luzz box, Steam Linux Runtime sniper, RUNPATH $ORIGIN)
#   out-dir  default build/steam/content/<os>
#
# Output = exactly what ships:
#   macos/   Bouncy Blobs.app (libsteam_api.dylib in Contents/MacOS)  launch: Bouncy Blobs.app
#   windows/ bouncy-blobs.exe + steam_api64.dll + assets/             launch: bouncy-blobs.exe
#   linux/   bouncy-blobs + libsteam_api.so + assets/                 launch: bouncy-blobs (sniper)
#
# The Steamworks redistributables come from the steamworks-sys crate the game
# links against (version from Cargo.lock), so the import and the shipped
# library always match. steam_appid.txt is never shipped.
set -euo pipefail

os="${1:?usage: assemble.sh <macos|windows|linux> <build> [out-dir]}"
build="${2:?usage: assemble.sh <macos|windows|linux> <build> [out-dir]}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${3:-$root/build/steam/content/$os}"
assets="$root/crates/bb-game/assets"

sysver="$(awk '/^name = "steamworks-sys"/{getline; gsub(/"/,"",$3); print $3; exit}' "$root/Cargo.lock")"
[ -n "$sysver" ] || { echo "assemble: steamworks-sys not in Cargo.lock" >&2; exit 1; }
sdk="$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/steamworks-sys-"$sysver"/lib/steam/redistributable_bin 2>/dev/null | head -1)"
[ -d "$sdk" ] || { echo "assemble: steamworks-sys $sysver sources not found (cargo fetch)" >&2; exit 1; }

[ -e "$build" ] || { echo "assemble: $build missing" >&2; exit 1; }
rm -rf "$out"
mkdir -p "$out"

case "$os" in
  macos)
    [ -d "$build/Contents/MacOS" ] || { echo "assemble: $build is not an .app" >&2; exit 1; }
    # ditto keeps symlinks, exec bits, the signature and the bundle structure intact.
    ditto "$build" "$out/Bouncy Blobs.app"
    [ -f "$out/Bouncy Blobs.app/Contents/MacOS/libsteam_api.dylib" ] || { echo "assemble: the .app has no libsteam_api.dylib (build with scripts/build-macos.sh --steam)" >&2; exit 1; }
    lipo -info "$out/Bouncy Blobs.app/Contents/MacOS/bouncy-blobs"
    ;;
  windows)
    cp "$build" "$out/bouncy-blobs.exe"
    cp "$sdk/win64/steam_api64.dll" "$out/"
    ditto "$assets" "$out/assets"
    ;;
  linux)
    cp "$build" "$out/bouncy-blobs"
    chmod 755 "$out/bouncy-blobs"
    cp "$sdk/linux64/libsteam_api.so" "$out/"
    ditto "$assets" "$out/assets"
    ;;
  *) echo "assemble: unknown os '$os'" >&2; exit 2 ;;
esac

find "$out" \( -name steam_appid.txt -o -name .DS_Store \) -delete
echo "content ready: $out ($(du -sh "$out" | cut -f1))"
