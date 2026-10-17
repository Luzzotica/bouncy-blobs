#!/usr/bin/env bash
# Print the newest CHANGELOG.md section in the two shapes a release needs.
#
#   scripts/release-notes.sh version-txt [--commit <sha>]   # VERSION.txt (beside the content build)
#   scripts/release-notes.sh steam                          # Steam patch-notes block (BBCode)
#   scripts/release-notes.sh version                        # just the newest version number
#
# The newest section is the first "## <version>" heading. Its version must
# match Cargo.toml's [workspace.package] version (we never bump here).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-version-txt}"; shift || true
commit=""
while [ $# -gt 0 ]; do
  case "$1" in --commit) commit="$2"; shift 2 ;; *) echo "release-notes: unknown arg $1" >&2; exit 2 ;; esac
done
[ -n "$commit" ] || commit="$(git -C "$root" rev-parse --short HEAD)"

cargo_version="$(awk -F'"' '/^\[workspace.package\]/{f=1} f&&/^version/{print $2; exit}' "$root/Cargo.toml")"
version="$(sed -n 's/^## \([^ ]*\).*/\1/p' "$root/CHANGELOG.md" | head -1)"
[ -n "$version" ] || { echo "release-notes: no '## <version>' section in CHANGELOG.md" >&2; exit 1; }
if [ "$version" != "$cargo_version" ]; then
  echo "release-notes: CHANGELOG's newest section is $version but Cargo.toml says $cargo_version" >&2; exit 1
fi
# Body of the newest section (between its heading and the next "## ").
body="$(awk 'BEGIN{n=0} /^## /{n++; next} n==1{print}' "$root/CHANGELOG.md" | sed -e '/./,$!d')"

case "$mode" in
  version) echo "$version" ;;
  version-txt)
    echo "Bouncy Blobs $version"
    echo "commit $commit, built $(date -u +%Y-%m-%d)"
    echo
    # Plain text: drop the markdown emphasis.
    printf '%s\n' "$body" | sed -e 's/\*\*//g' -e 's/\*\([^*]*\)\*/\1/g'
    ;;
  steam)
    # Steam event/patch notes take BBCode.
    echo "[h2]Bouncy Blobs $version[/h2]"
    printf '%s\n' "$body" | python3 -c '
import re, sys
# Join wrapped bullet lines, then markdown -> BBCode.
lines = []
for line in sys.stdin.read().splitlines():
    if line.startswith("  ") and lines and lines[-1].startswith("- "):
        lines[-1] += " " + line.strip()
    else:
        lines.append(line)
inlist = False
for line in lines:
    t = re.sub(r"\*\*(.+?)\*\*", r"[b]\1[/b]", line)
    t = re.sub(r"\*(.+?)\*", r"[i]\1[/i]", t)
    if t.startswith("- "):
        if not inlist: print("[list]"); inlist = True
        print("[*]" + t[2:])
        continue
    if inlist: print("[/list]"); inlist = False
    print(t)
if inlist: print("[/list]")
'
    ;;
  *) echo "release-notes: mode is version-txt | steam | version" >&2; exit 2 ;;
esac
