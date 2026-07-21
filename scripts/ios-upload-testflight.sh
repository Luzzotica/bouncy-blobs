#!/usr/bin/env bash
# Upload a local Bouncy Blobs .ipa to App Store Connect / TestFlight.
#
# Prereqs:
#   - Xcode signed into the Apple ID that owns team 74874V9Z5H
#   - ASC app record for me.sterlinglong.bouncyblobs
#   - An .ipa from `npm run ios:build` (export method app-store-connect)
#
# Auth (pick one):
#   A) App Store Connect API key (CI-friendly):
#        export ASC_KEY_ID=...
#        export ASC_ISSUER_ID=...
#        export ASC_KEY_PATH=~/AuthKey_XXXX.p8
#   B) Apple ID + app-specific password:
#        export APPLE_ID=you@example.com
#        export APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
#
# Usage:
#   npm run ios:upload
#   bash scripts/ios-upload-testflight.sh path/to/Bouncy\ Blobs.ipa

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEAM_ID="${APPLE_TEAM_ID:-74874V9Z5H}"
BUNDLE_ID="me.sterlinglong.bouncyblobs"

find_ipa() {
  if [[ $# -ge 1 && -f "$1" ]]; then
    echo "$1"
    return
  fi
  # Prefer the newest ipa under gen/apple or tauri target
  local candidates=()
  while IFS= read -r -d '' f; do candidates+=("$f"); done < <(
    find "$ROOT/src-tauri" -name '*.ipa' -type f -print0 2>/dev/null
  )
  if [[ ${#candidates[@]} -eq 0 ]]; then
    echo "error: no .ipa found under src-tauri/. Run: npm run ios:build" >&2
    exit 1
  fi
  # Newest by mtime
  ls -t "${candidates[@]}" | head -1
}

IPA="$(find_ipa "${1:-}")"
echo "Uploading: $IPA"
echo "  team:   $TEAM_ID"
echo "  bundle: $BUNDLE_ID"

if [[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" && -n "${ASC_KEY_PATH:-}" ]]; then
  echo "Auth: App Store Connect API key ($ASC_KEY_ID)"
  xcrun altool --upload-app \
    --type ios \
    --file "$IPA" \
    --apiKey "$ASC_KEY_ID" \
    --apiIssuer "$ASC_ISSUER_ID" \
    --apiKeyPath "$ASC_KEY_PATH"
elif [[ -n "${APPLE_ID:-}" && -n "${APP_SPECIFIC_PASSWORD:-}" ]]; then
  echo "Auth: Apple ID ($APPLE_ID)"
  xcrun altool --upload-app \
    --type ios \
    --file "$IPA" \
    --username "$APPLE_ID" \
    --password "$APP_SPECIFIC_PASSWORD"
else
  cat >&2 <<EOF
No upload credentials in the environment.

Either set ASC API key vars:
  export ASC_KEY_ID=...
  export ASC_ISSUER_ID=...
  export ASC_KEY_PATH=~/AuthKey_XXXX.p8

Or Apple ID + app-specific password:
  export APPLE_ID=...
  export APP_SPECIFIC_PASSWORD=...

Or drag the .ipa into Transporter.app:
  open -a Transporter
  IPA: $IPA
EOF
  exit 2
fi

echo "Upload submitted. ASC processes builds ~10 min → TestFlight → add internal testers."
