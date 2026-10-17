#!/usr/bin/env bash
# Upload assembled depot content to Steam with steamcmd. Copied from
# tankii-worlds/scripts/steam/upload.sh: generates the app_build VDF, then runs it.
#
#   scripts/steam/upload.sh --app 4485010 [--content build/steam/content] [--desc "…"] [--dry-run]
#   scripts/steam/upload.sh --app <id> --depot-windows <id> --depot-macos <id> --depot-linux <id>
#
# Depot ids come from scripts/steam/apps.env (STEAM_MAIN_* when --app is the
# full game, STEAM_DEMO_* for the demo) unless given as flags. There is no
# "first depot + n" guessing: a platform without a depot id is dropped with a
# note, and so is a platform without content (<content>/<os>/ empty or missing).
#
# Never sets a branch live: "SetLive" is always empty (Sterling sets builds
# live in Steamworks; the builder can't touch the default branch anyway).
#
# --dry-run   write the VDF and print it, run nothing (no login, no upload).
#
# Needs: steamcmd (brew install --cask steamcmd) and the builder's cached
# Steam Guard login in STEAM_HOME (HOME=~/.steam-builder steamcmd +login acitozzul
# once). Prints "BUILDID <app> <id>" on success.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=apps.env
source "$root/scripts/steam/apps.env"
app=""; desc=""; content="$root/build/steam/content"; dry=false
depot_windows="${STEAM_DEPOT_WINDOWS:-}"; depot_macos="${STEAM_DEPOT_MACOS:-}"; depot_linux="${STEAM_DEPOT_LINUX:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --app) app="$2"; shift 2 ;;
    --desc) desc="$2"; shift 2 ;;
    --content) content="$2"; shift 2 ;;
    --depot-windows) depot_windows="$2"; shift 2 ;;
    --depot-macos) depot_macos="$2"; shift 2 ;;
    --depot-linux) depot_linux="$2"; shift 2 ;;
    --dry-run) dry=true; shift ;;
    --branch|--set-live) echo "upload.sh never sets a branch live (Sterling does that in Steamworks)" >&2; exit 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
[ -n "$app" ] || { echo "--app <steam app id> is required" >&2; exit 2; }
# Fill unset depot ids from apps.env for the apps we know.
if [ "$app" = "$STEAM_MAIN_APP_ID" ]; then
  depot_windows="${depot_windows:-$STEAM_MAIN_DEPOT_WINDOWS}"; depot_macos="${depot_macos:-$STEAM_MAIN_DEPOT_MACOS}"; depot_linux="${depot_linux:-$STEAM_MAIN_DEPOT_LINUX}"
elif [ -n "$STEAM_DEMO_APP_ID" ] && [ "$app" = "$STEAM_DEMO_APP_ID" ]; then
  depot_windows="${depot_windows:-$STEAM_DEMO_DEPOT_WINDOWS}"; depot_macos="${depot_macos:-$STEAM_DEMO_DEPOT_MACOS}"; depot_linux="${depot_linux:-$STEAM_DEMO_DEPOT_LINUX}"
fi
version="$(awk -F'"' '/^\[workspace.package\]/{f=1} f&&/^version/{print $2; exit}' "$root/Cargo.toml")"
[ -n "$desc" ] || desc="bouncy-blobs $version $(git -C "$root" rev-parse --short HEAD)"
content="$(cd "$content" 2>/dev/null && pwd)" || { echo "no content dir (run scripts/steam/assemble.sh first)" >&2; exit 1; }

depots=""
for os in windows macos linux; do
  dir="$content/$os"
  case "$os" in
    windows) id="$depot_windows" ;;
    macos) id="$depot_macos" ;;
    linux) id="$depot_linux" ;;
  esac
  if [ -z "$id" ]; then
    [ -d "$dir" ] && echo "skip $os: no depot id for app $app (apps.env)" || echo "skip $os: no depot id, no content"
    continue
  fi
  if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
    # Never ship the dev app-id file: a stray steam_appid.txt bypasses Steam's ownership check.
    if [ -n "$(find "$dir" -name steam_appid.txt)" ]; then echo "refusing: steam_appid.txt in $dir" >&2; exit 1; fi
    echo "depot $id <- $os"
    depots+=$'\n'"    \"$id\" { \"FileMapping\" { \"LocalPath\" \"$os/*\" \"DepotPath\" \".\" \"Recursive\" \"1\" } }"
  else
    echo "skip $os: no content at $dir"
  fi
done
[ -n "$depots" ] || { echo "nothing to upload for app $app" >&2; exit 1; }

out="$root/build/steam/output"; mkdir -p "$out"
vdf="$out/app_build_$app.vdf"
cat > "$vdf" <<VDF
"AppBuild"
{
  "AppID" "$app"
  "Desc" "$desc"
  "ContentRoot" "$content"
  "BuildOutput" "$out"
  "SetLive" ""
  "Depots"
  {$depots
  }
}
VDF
echo "== $vdf"; cat "$vdf"
if [ "$dry" = true ]; then echo "dry run: not uploading"; exit 0; fi

command -v steamcmd >/dev/null || { echo "steamcmd not found (brew install --cask steamcmd)" >&2; exit 1; }
: "${STEAM_USERNAME:?set STEAM_USERNAME (builder account)}"
log="$out/steamcmd-$app.log"
# STEAM_HOME: the throwaway HOME holding only the builder's cached login, so
# the Steam client's own config is never touched and no personal account rides along.
( if [ -n "${STEAM_HOME:-}" ]; then export HOME="$STEAM_HOME"; fi
  if [ -n "${STEAM_PASSWORD:-}" ]; then
    steamcmd +login "$STEAM_USERNAME" "$STEAM_PASSWORD" +run_app_build "$vdf" +quit
  else
    steamcmd +login "$STEAM_USERNAME" +run_app_build "$vdf" +quit
  fi ) </dev/null 2>&1 | tee "$log"
buildid="$(sed -n 's/.*(BuildID \([0-9]*\)).*/\1/p' "$log" | tail -1)"
if grep -q "Successfully finished AppID $app build" "$log" && [ -n "$buildid" ]; then
  echo "BUILDID $app $buildid"
else
  echo "FAILED: $(grep -E 'ERROR|Failed|Access Denied' "$log" | tail -1)" >&2
  exit 1
fi
