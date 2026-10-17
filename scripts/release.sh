#!/usr/bin/env bash
# The whole release matrix for ONE commit (BUILD-MATRIX.md, docs/Release.md):
#   macOS universal build here -> Windows + Linux from the Luzz box -> assemble
#   -> leak scan -> Steam upload (no branch) -> partii upload (live) -> report.
#
#   scripts/release.sh request-box <commit>    # ask the Luzz box for Windows + Linux
#   scripts/release.sh <commit> --dry-run      # everything up to (not incl.) the uploads
#   scripts/release.sh <commit>                # the real thing
#
# Options:
#   --dry-run          build, fetch, assemble, scan, package, write the VDFs; no uploads
#   --skip-mac-build   reuse build/macos/"Bouncy Blobs.app" (must be from <commit>)
#   --no-box           don't wait for Windows/Linux: report them skipped
#   --only-steam / --only-partii
#
# Box artifacts: a (draft) GitHub release on Luzzotica/bouncy-blobs tagged
# release-<version>-<sha7>, assets bouncy-blobs.exe + bouncy-blobs (Linux).
# Run from a checkout AT <commit> (clean tracked tree). Everything lands in
# build/release/<sha7>/; report.txt holds the nightly lines.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
GAME=bouncy-blobs
REPO=Luzzotica/bouncy-blobs

cmd="release"
if [ "${1:-}" = request-box ]; then cmd=request-box; shift; fi
commit_arg="${1:?usage: scripts/release.sh [request-box] <commit> [--dry-run] [--skip-mac-build] [--no-box]}"; shift
dry=false; skip_mac=false; no_box=false; do_steam=true; do_partii=true
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=true ;;
    --skip-mac-build) skip_mac=true ;;
    --no-box) no_box=true ;;
    --only-steam) do_partii=false ;;
    --only-partii) do_steam=false ;;
    *) echo "release: unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done

commit="$(git rev-parse --verify "$commit_arg^{commit}")"
sha7="${commit:0:7}"
version="$(awk -F'"' '/^\[workspace.package\]/{f=1} f&&/^version/{print $2; exit}' Cargo.toml)"
tag="release-$version-$sha7"
partii_commit="$(git -C "$ROOT/../partii" rev-parse HEAD 2>/dev/null || echo unknown)"
OUT="$ROOT/build/release/$sha7"
mkdir -p "$OUT"

# ---------------------------------------------------------------- request-box
if [ "$cmd" = request-box ]; then
  git branch -r --contains "$commit" | grep -q . || { echo "release: $sha7 isn't pushed; the box can't fetch it (git push origin <branch>)" >&2; exit 1; }
  git -C "$ROOT/../partii" branch -r --contains "$partii_commit" 2>/dev/null | grep -q . || echo "WARNING: partii $partii_commit isn't on any remote branch" >&2
  req="$OUT/box-request.md"
  cat > "$req" <<EOF
# bouncy-blobs RELEASE $version ($sha7): Windows + Linux (2 builds)

Commits (all pushed):
- bouncy-blobs ($REPO) **$commit**
- partii (Luzzotica/partii) **$partii_commit**, checked out as a SIBLING of bouncy-blobs
  (\`<dir>/bouncy-blobs\` + \`<dir>/partii\`; bb-net path-depends on ../../../partii/platform/crates).

Build under \`env -i HOME PATH USER LANG=C.UTF-8 TMPDIR=/tmp\`, never with a secrets file sourced.
BB_PARTII_KEY / BB_PARTII_API / BB_CONTROLLER_URL / BB_STAGING must NOT be set (option_env! bakes
them). \`git status\` clean before building (build.rs bakes the commit). One binary serves Steam
and partii.

## Draft release on $REPO, tag \`$tag\`
1. **win**: \`cargo xwin build --release --target x86_64-pc-windows-msvc -p bb-game --bin bouncy-blobs --features steam\`
   -> asset \`bouncy-blobs.exe\` (PE subsystem must be GUI = 2)
2. **linux** (steamrt/sniper/sdk): \`cargo build --release -p bb-game --bin bouncy-blobs --features steam\`
   -> asset \`bouncy-blobs\` (755). RUNPATH must be \`\$ORIGIN\` (build.rs adds it; else patchelf --set-rpath '\$ORIGIN').

Per build: sha256, size, leak check (CLAUDE*, K2SO*, K2_*, SSH_AUTH_SOCK, STAGING_*, ASCII + UTF-16);
Linux also RUNPATH, max GLIBC, ldd not-found count. Reply to \`bouncy-blobs\` with \`k2 msg --inbox-wake\`.
EOF
  echo "box request: $req"
  if k2 msg compiler::luzz.k2.dev --inbox-wake "$req" --title "bouncy-blobs release $version ($sha7): Windows + Linux" 2>&1 | grep -q '"ok":true'; then
    echo "sent to compiler::luzz.k2.dev"
  else
    echo "couldn't reach compiler::luzz.k2.dev directly (bouncy-blobs isn't connected?); relaying via games"
    k2 msg games --inbox-wake "$req" --title "bouncy-blobs: please relay to compiler::luzz.k2.dev ($tag)" --body "bouncy-blobs isn't connected to the box. Please forward the attached request." 2>&1 | tail -1
  fi
  exit 0
fi

# ---------------------------------------------------------------- preflight
REPORT="$OUT/report.txt"; : > "$REPORT"
line() { echo "$*" | tee -a "$REPORT"; }
[ "$(git rev-parse HEAD)" = "$commit" ] || { echo "release: HEAD is $(git rev-parse --short HEAD), not $sha7 (git checkout $sha7)" >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "release: tracked files are modified; release builds come from a clean commit" >&2; exit 1; }
[ -z "${CARGO_TARGET_DIR:-}" ] || { echo "release: unset CARGO_TARGET_DIR (each worktree builds into its own ./target)" >&2; exit 1; }
# Staging must never reach a release build (bb-net bakes these with option_env!).
for v in BB_STAGING BB_PARTII_KEY BB_PARTII_API BB_CONTROLLER_URL BB_PARTII_PLAYER_TOKEN; do
  if [ -n "${!v:-}" ]; then echo "release: $v is set; release builds use production only. Unset it." >&2; exit 1; fi
done
notes_version="$(bash scripts/release-notes.sh version)"   # fails if CHANGELOG != Cargo.toml
echo "== bouncy-blobs $version ($sha7), partii $partii_commit, $( $dry && echo DRY RUN || echo REAL )"

# ---------------------------------------------------------------- macOS (here)
APP="$ROOT/build/macos/Bouncy Blobs.app"
if [ "$skip_mac" = false ]; then
  echo "== macOS universal build (cargo through the rustq queue)"
  bash scripts/build-macos.sh --steam > "$OUT/mac-build.log" 2>&1 || { tail -20 "$OUT/mac-build.log"; echo "macOS build FAILED"; exit 1; }
fi
[ -f "$APP/Contents/MacOS/bouncy-blobs" ] || { echo "release: no $APP" >&2; exit 1; }
grep -aq "$sha7" "$APP/Contents/MacOS/bouncy-blobs" || { echo "release: $APP isn't built from $sha7 (drop --skip-mac-build)" >&2; exit 1; }

# ---------------------------------------------------------------- Windows + Linux (box)
BOX="$OUT/box"; mkdir -p "$BOX"
have_win=false; have_linux=false
if [ "$no_box" = false ]; then
  if gh release view "$tag" -R "$REPO" >/dev/null 2>&1; then
    gh release download "$tag" -R "$REPO" -D "$BOX" --clobber -p bouncy-blobs.exe -p bouncy-blobs 2>&1 | tail -2 || true
  else
    echo "release: no box release $tag yet. Run: scripts/release.sh request-box $sha7  (or --no-box)" >&2; exit 3
  fi
fi
if [ -f "$BOX/bouncy-blobs.exe" ]; then
  sub="$(python3 -c 'import struct,sys; d=open(sys.argv[1],"rb").read(4096); o=struct.unpack_from("<I",d,0x3c)[0]; print(struct.unpack_from("<H",d,o+24+68)[0])' "$BOX/bouncy-blobs.exe")"
  [ "$sub" = 2 ] && have_win=true || echo "windows: PE subsystem $sub (not GUI): not shipping it"
fi
if [ -f "$BOX/bouncy-blobs" ]; then
  RE=/opt/homebrew/opt/llvm/bin/llvm-readelf
  if [ -x "$RE" ]; then
    rp="$("$RE" -d "$BOX/bouncy-blobs" | sed -n 's/.*(RUNPATH).*\[\(.*\)\].*/\1/p')"
    [ "$rp" = '$ORIGIN' ] && have_linux=true || echo "linux: RUNPATH is '$rp', not \$ORIGIN: not shipping it"
  else
    have_linux=true; echo "linux: llvm-readelf missing, RUNPATH not checked"
  fi
fi

# ---------------------------------------------------------------- assemble + scan + package
CONTENT="$OUT/content"; rm -rf "$CONTENT"; mkdir -p "$CONTENT"
bash scripts/steam/assemble.sh macos "$APP" "$CONTENT/macos"
$have_win && bash scripts/steam/assemble.sh windows "$BOX/bouncy-blobs.exe" "$CONTENT/windows"
$have_linux && bash scripts/steam/assemble.sh linux "$BOX/bouncy-blobs" "$CONTENT/linux"

echo "== leak scan"
if ! python3 -I scripts/leakscan.py "$CONTENT" | tee "$OUT/leakscan.txt"; then
  line "$GAME full * *: FAILED (leak scan hit, see $OUT/leakscan.txt): nothing uploaded"
  exit 1
fi

bash scripts/release-notes.sh version-txt --commit "$sha7" > "$OUT/VERSION.txt"
bash scripts/release-notes.sh steam > "$OUT/steam-patch-notes.txt"
PKG="$OUT/partii"; rm -rf "$PKG"; mkdir -p "$PKG"
zips=()
for os in macos windows linux; do
  [ -d "$CONTENT/$os" ] || continue
  z="$PKG/$GAME-$version-$os.zip"
  if [ "$os" = macos ]; then
    ditto -c -k --keepParent "$CONTENT/macos/Bouncy Blobs.app" "$z"
  else
    # One top folder; zip keeps the exec bit (Info-ZIP unix attributes).
    stage="$OUT/stage-$os/BouncyBlobs"; rm -rf "$OUT/stage-$os"; mkdir -p "$stage"
    ditto "$CONTENT/$os" "$stage"; cp "$OUT/VERSION.txt" "$stage/"
    (cd "$OUT/stage-$os" && zip -qry "$z" BouncyBlobs); rm -rf "$OUT/stage-$os"
  fi
  zips+=("$os=$z")
done
ls -lh "$PKG"

# ---------------------------------------------------------------- Steam (no branch, never live)
source scripts/steam/apps.env
dryflag=(); $dry && dryflag=(--dry-run)
steam_app() {  # <variant> <app id> <win> <mac> <linux>
  local variant="$1" app="$2" w="$3" m="$4" l="$5" res id
  if [ -z "$app" ]; then
    for os in macos windows linux; do line "$GAME $variant $os steam: skipped (no Steam app id yet)"; done; return
  fi
  if res="$(bash scripts/steam/upload.sh --app "$app" --content "$CONTENT" --depot-windows "$w" --depot-macos "$m" --depot-linux "$l" \
        --desc "$GAME $version $sha7" ${dryflag[@]+"${dryflag[@]}"} 2>&1)"; then :; else
    echo "$res" | tail -5
    for os in macos windows linux; do line "$GAME $variant $os steam: FAILED ($(echo "$res" | grep -E 'FAILED|ERROR|Denied' | tail -1))"; done; return
  fi
  echo "$res" | grep -E '^(depot|skip|BUILDID|dry run)'
  id="$(echo "$res" | sed -n 's/^BUILDID [0-9]* //p')"
  for os in macos windows linux; do
    local dep; case $os in macos) dep="$m" ;; windows) dep="$w" ;; linux) dep="$l" ;; esac
    if [ ! -d "$CONTENT/$os" ]; then line "$GAME $variant $os steam: skipped (no $os build)"
    elif [ -z "$dep" ]; then line "$GAME $variant $os steam: skipped (no depot id in apps.env)"
    elif $dry; then line "$GAME $variant $os steam: dry run (depot $dep, VDF build/steam/output/app_build_$app.vdf)"
    else line "$GAME $variant $os steam: uploaded BuildID $id (app $app depot $dep, no branch)"; fi
  done
}
if $do_steam; then
  echo "== Steam"
  steam_app full "$STEAM_MAIN_APP_ID" "$STEAM_MAIN_DEPOT_WINDOWS" "$STEAM_MAIN_DEPOT_MACOS" "$STEAM_MAIN_DEPOT_LINUX"
  # One binary runs as the demo when not owned, so the demo ships the same content.
  steam_app demo "$STEAM_DEMO_APP_ID" "$STEAM_DEMO_DEPOT_WINDOWS" "$STEAM_DEMO_DEPOT_MACOS" "$STEAM_DEMO_DEPOT_LINUX"
fi

# ---------------------------------------------------------------- partii (live on upload)
if $do_partii; then
  echo "== partii"
  pres="$(bash scripts/partii-upload.sh --version "$version" --channel stable ${dryflag[@]+"${dryflag[@]}"} "${zips[@]}" 2>&1)" || true
  echo "$pres"
  for os in macos windows linux; do
    l="$(echo "$pres" | grep "^PARTII $os " || true)"
    if [ ! -d "$CONTENT/$os" ]; then line "$GAME full $os partii: skipped (no $os build)"
    elif [ -z "$l" ]; then line "$GAME full $os partii: FAILED (no result)"
    elif echo "$l" | grep -q FAILED; then line "$GAME full $os partii: ${l#PARTII $os }"
    elif $dry; then line "$GAME full $os partii: dry run ($version, $(basename "$PKG/$GAME-$version-$os.zip"))"
    else line "$GAME full $os partii: uploaded $(echo "$l" | awk '{print $3}') $version"; fi
  done
fi

echo
echo "== report ($REPORT)"; cat "$REPORT"
echo; echo "== Steam patch notes ($OUT/steam-patch-notes.txt)"; cat "$OUT/steam-patch-notes.txt"
