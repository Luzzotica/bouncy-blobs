#!/usr/bin/env bash
# Upload release builds to the partii PRODUCTION store, then prune: keep the new
# build and the previous one per platform (the fallback), delete older ones.
# partii builds are live the moment they're uploaded (Sterling's call).
#
#   scripts/partii-upload.sh --version 3.0.0 [--channel stable] [--dry-run] \
#       macos=build/release/bouncy-blobs-3.0.0-macos.zip \
#       windows=build/release/bouncy-blobs-3.0.0-windows.zip \
#       linux=build/release/bouncy-blobs-3.0.0-linux.zip
#
# --dry-run  partii's own --dry-run for the uploads (nothing sent) and only
#            PRINTS which builds the prune would delete.
#
# Auth: PARTII_TOKEN from the environment, else PROD_DEV_TOKEN from
# ~/.config/partii/production.env. Never ~/.config/partii/bouncy-blobs-game.env:
# its PARTII_API/PARTII_TOKEN are STAGING. The token is never printed.
# Prints "PARTII <platform> <build id> <version>" per upload.
set -euo pipefail

game=bouncy-blobs; version=""; channel=stable; dry=false; items=()
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --channel) channel="$2"; shift 2 ;;
    --dry-run) dry=true; shift ;;
    macos=*|windows=*|linux=*) items+=("$1"); shift ;;
    *) echo "partii-upload: unknown arg $1" >&2; exit 2 ;;
  esac
done
[ -n "$version" ] || { echo "partii-upload: --version is required" >&2; exit 2; }
[ "${#items[@]}" -gt 0 ] || { echo "partii-upload: nothing to upload (platform=file ...)" >&2; exit 2; }
command -v partii >/dev/null || { echo "partii CLI not found" >&2; exit 1; }

# Production only.
export PARTII_API="https://api.partii.games"
if [ -z "${PARTII_TOKEN:-}" ]; then
  f="$HOME/.config/partii/production.env"
  [ -f "$f" ] && PARTII_TOKEN="$(grep '^PROD_DEV_TOKEN=' "$f" | head -1 | cut -d= -f2- | tr -d '\r"'"'")"
fi
[ -n "${PARTII_TOKEN:-}" ] || { echo "partii-upload: no developer token (PARTII_TOKEN or PROD_DEV_TOKEN in ~/.config/partii/production.env)" >&2; exit 1; }
export PARTII_TOKEN
unset PARTII_KEY PARTII_PLAYER_TOKEN PARTII_ADMIN_TOKEN
# Belt and braces: never echo the token even if the CLI does.
redact() { sed -e "s/${PARTII_TOKEN//\//\\/}/<token>/g"; }

partii whoami | redact | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok"), d; print("partii: signed in as", d["developer"]["email"], "(production)")'

fail=0
for it in "${items[@]}"; do
  platform="${it%%=*}"; file="${it#*=}"
  [ -f "$file" ] || { echo "PARTII $platform FAILED (missing $file)"; fail=1; continue; }
  args=(builds upload "$game" --platform "$platform" --version "$version" --channel "$channel" --filename "$(basename "$file")" --file "$file")
  [ "$dry" = true ] && args+=(--dry-run)
  out="$(partii "${args[@]}" 2>&1 | redact)" || true
  id="$(printf '%s' "$out" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
if not d.get("ok"): sys.exit(1)
print("dry-run" if d.get("dry_run") else d.get("build",{}).get("id") or d.get("id") or "?")' 2>/dev/null)" || { echo "PARTII $platform FAILED ($(printf '%s' "$out" | tail -c 300))"; fail=1; continue; }
  echo "PARTII $platform $id $version ($(du -h "$file" | cut -f1))"
done

# Prune: per uploaded platform, keep the newest two builds on this channel.
partii builds list "$game" | redact > "${TMPDIR:-/tmp}/partii-builds.$$.json"
platforms="$(for it in "${items[@]}"; do printf '%s\n' "${it%%=*}"; done)"
python3 - "${TMPDIR:-/tmp}/partii-builds.$$.json" "$channel" "$dry" "$platforms" <<'PY' | while read -r verb bid desc; do
import json, sys
d = json.load(open(sys.argv[1])); channel = sys.argv[2]; dry = sys.argv[3] == "true"
plats = sys.argv[4].split()
for p in plats:
    bs = sorted((b for b in d.get("builds", []) if b["platform"] == p and b.get("channel") == channel), key=lambda b: b["created_at"], reverse=True)
    # A dry run uploaded nothing, so "new + previous" are one slot further down.
    keep = 1 if dry else 2
    for b in bs[keep:]:
        print("delete", b["id"], f'{p}:{b["version"]}:{b["filename"]}')
PY
  if [ "$dry" = true ]; then echo "would delete $bid ($desc)"; else
    partii builds delete "$game" "$bid" | redact >/dev/null && echo "deleted $bid ($desc)" || echo "WARN: delete $bid failed"; fi
done
rm -f "${TMPDIR:-/tmp}/partii-builds.$$.json"
exit "$fail"
