#!/usr/bin/env bash
# Archive the iOS app and export an App Store Connect .ipa (does NOT upload).
#
#   scripts/ios-build.sh                    # uses CURRENT_PROJECT_VERSION from ios/project.yml
#   scripts/ios-build.sh --build 3.0.0.2    # override CFBundleVersion for this train
#
# Output: build/ios/BouncyBlobs.xcarchive and build/ios/export/Bouncy Blobs.ipa
# Then:   scripts/ios-upload-testflight.sh
#
# Needs: Xcode signed into the Apple ID for team 74874V9Z5H (automatic signing,
# "Apple Distribution" certificate available for export).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"

BUILD_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD_ARGS+=("CURRENT_PROJECT_VERSION=$2"); shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done

OUT="$ROOT/build/ios"
ARCHIVE="$OUT/BouncyBlobs.xcarchive"
rm -rf "$ARCHIVE" "$OUT/export"
mkdir -p "$OUT"

# Regenerate the project if xcodegen is present (keeps project.yml the source of truth).
if command -v xcodegen >/dev/null; then (cd ios && xcodegen --quiet); fi

xcodebuild -project ios/BouncyBlobs.xcodeproj -scheme BouncyBlobs \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" -allowProvisioningUpdates \
  ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} archive

xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist ios/ExportOptions.plist \
  -exportPath "$OUT/export" -allowProvisioningUpdates

echo "IPA: $(ls "$OUT"/export/*.ipa)"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' -c 'Print :CFBundleVersion' \
  "$ARCHIVE/Products/Applications/Bouncy Blobs.app/Info.plist"
