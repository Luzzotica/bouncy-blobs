#!/usr/bin/env bash
# Build the Android app (GameActivity + crates/bb-mobile via cargo-ndk).
#   scripts/android-build.sh                 # debug APK (arm64-v8a + x86_64)
#   scripts/android-build.sh --release       # release APK
#   scripts/android-build.sh --aab           # release App Bundle for Play
#   scripts/android-build.sh --install       # debug APK + adb install + launch
# Env: ANDROID_HOME (default ~/Library/Android/sdk), ANDROID_NDK_HOME (default
# newest $ANDROID_HOME/ndk/*), ABIS (default "arm64-v8a x86_64"),
# BB_VERSION_CODE (Play versionCode, default 3000001).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
source "$ROOT/scripts/lib/mp-api-key.sh"

MODE=debug; AAB=0; INSTALL=0
for a in "$@"; do
  case "$a" in
    --release) MODE=release ;;
    --aab) MODE=release; AAB=1 ;;
    --install) INSTALL=1 ;;
    *) echo "unknown arg $a" >&2; exit 2 ;;
  esac
done

export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ ! -d "$ANDROID_HOME/platforms" ]]; then
  cat >&2 <<MSG
error: Android SDK not found at $ANDROID_HOME
Install Android Studio (or the command-line tools), then in SDK Manager install:
  - Android SDK Platform 36, Build-Tools, Platform-Tools
  - NDK (Side by side) 28.x
See docs/Platforms.md#android.
MSG
  exit 1
fi
if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
  ANDROID_NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1 || true)"
fi
[[ -d "${ANDROID_NDK_HOME:-}" ]] || { echo "error: no NDK under $ANDROID_HOME/ndk (install 'NDK (Side by side)')" >&2; exit 1; }
export ANDROID_NDK_HOME
echo "sdk: $ANDROID_HOME"; echo "ndk: $ANDROID_NDK_HOME"
command -v cargo-ndk >/dev/null || cargo install cargo-ndk --locked

ABIS="${ABIS:-arm64-v8a x86_64}"
TARGET_ARGS=()
for abi in $ABIS; do
  TARGET_ARGS+=(-t "$abi")
  case "$abi" in
    arm64-v8a) rustup target add aarch64-linux-android >/dev/null 2>&1 || true ;;
    x86_64) rustup target add x86_64-linux-android >/dev/null 2>&1 || true ;;
  esac
done

CARGO_PROFILE=(); [[ $MODE == release ]] && CARGO_PROFILE=(--release)
JNI="$ROOT/android/app/src/main/jniLibs"
rm -rf "$JNI"
cargo ndk "${TARGET_ARGS[@]}" -P 31 -o "$JNI" build ${CARGO_PROFILE[@]+"${CARGO_PROFILE[@]}"} -p bb-mobile --lib

NDK_VER="$(basename "$ANDROID_NDK_HOME")"
cd android
if [[ $AAB == 1 ]]; then
  ./gradlew -Pbb.ndkVersion="$NDK_VER" bundleRelease
  OUT="$(ls app/build/outputs/bundle/release/*.aab)"
elif [[ $MODE == release ]]; then
  ./gradlew -Pbb.ndkVersion="$NDK_VER" assembleRelease
  OUT="$(ls app/build/outputs/apk/release/*.apk)"
else
  ./gradlew -Pbb.ndkVersion="$NDK_VER" assembleDebug
  OUT="$(ls app/build/outputs/apk/debug/*.apk)"
fi
echo "built: android/$OUT"

if [[ $INSTALL == 1 ]]; then
  ADB="$ANDROID_HOME/platform-tools/adb"
  "$ADB" install -r "$OUT"
  APP_ID=me.sterlinglong.bouncyblobs; [[ $MODE == debug ]] && APP_ID="$APP_ID.debug"
  "$ADB" shell am start -n "$APP_ID/me.sterlinglong.bouncyblobs.MainActivity"
  echo "logs: $ADB logcat -s RustStdoutStderr:V bevy:V"
fi
