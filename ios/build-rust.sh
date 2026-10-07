#!/usr/bin/env bash
# Xcode "Build Rust" phase: compiles crates/bb-mobile for the active SDK/arch
# and installs the executable as the app binary (Bevy 0.19 mobile pattern).
# Also usable by hand: PLATFORM_NAME=iphonesimulator ARCHS=arm64 ./build-rust.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Xcode puts its own toolchain first on PATH, which breaks linking host build
# scripts (rust-lang/rust#80817). Use the system cc plus rustup's cargo.
export PATH="$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# SDKROOT points at the iOS SDK; host build scripts/proc-macros must link
# against macOS, and the cc crate picks the right SDK per target itself.
unset SDKROOT
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-14.0}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
# Share the workspace target dir so Xcode builds reuse `cargo` caches.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
ROOT="$REPO_ROOT"; source "$REPO_ROOT/scripts/lib/mp-api-key.sh"

CONFIGURATION="${CONFIGURATION:-Debug}"
PLATFORM_NAME="${PLATFORM_NAME:-iphonesimulator}"
ARCHS="${ARCHS:-arm64}"

if [[ "$CONFIGURATION" == "Debug" ]]; then
  PROFILE=debug; RELFLAG=""
else
  PROFILE=release; RELFLAG="--release"
fi

EXECUTABLES=()
for arch in $ARCHS; do
  case "$PLATFORM_NAME:$arch" in
    iphonesimulator:arm64)  TARGET=aarch64-apple-ios-sim ;;
    iphonesimulator:x86_64) TARGET=x86_64-apple-ios ;;
    iphoneos:arm64)         TARGET=aarch64-apple-ios ;;
    *) echo "error: unsupported $PLATFORM_NAME/$arch" >&2; exit 2 ;;
  esac
  (cd "$REPO_ROOT" && cargo build $RELFLAG --target "$TARGET" -p bb-mobile --bin bb-mobile)
  EXECUTABLES+=("$CARGO_TARGET_DIR/$TARGET/$PROFILE/bb-mobile")
done

if [[ -n "${TARGET_BUILD_DIR:-}" && -n "${EXECUTABLE_PATH:-}" ]]; then
  mkdir -p "$(dirname "$TARGET_BUILD_DIR/$EXECUTABLE_PATH")"
  lipo -create -output "$TARGET_BUILD_DIR/$EXECUTABLE_PATH" "${EXECUTABLES[@]}"
  echo "installed ${EXECUTABLES[*]} -> $TARGET_BUILD_DIR/$EXECUTABLE_PATH"
fi
