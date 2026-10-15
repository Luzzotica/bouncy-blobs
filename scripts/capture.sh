#!/usr/bin/env bash
# Capture helpers for Bouncy Blobs clips (see docs/Capture.md).
#
#   scripts/capture.sh render OUT.mp4 [VAR=value ...]
#       Headless fixed-step render (nothing opens on screen). Passes the
#       VARs (BB_LEVEL, BB_CAPTURE_*, BB_PRESS, BB_TAP, ...) to the game,
#       sets BB_CAPTURE_OUT=OUT.mp4 and uses a throwaway HOME so saves and
#       prefs on this machine are never touched. Writes OUT.mp4 and
#       OUT.mp4.audio.tsv (the sounds the game started during the clip).
#
#   scripts/capture.sh music OUT.mp4 cave|bright [SECONDS]
#       Sidecar music stem OUT.wav: the biome's music loop (theme-cave.mp3
#       for cave biomes, theme.mp3 for bright ones; see audio.rs
#       theme_music) trimmed to the clip length. A music stem only — it is
#       NOT live game audio.
#
#   scripts/capture.sh mix OUT.mp4 [--with-music] [--only PREFIX]
#       Rebuild the clip's soundtrack from OUT.mp4.audio.tsv: every logged
#       game clip (voice, sfx; music too with --with-music) placed at the
#       time the game started it, at the game's gain, and mux it into
#       OUT.mp4 as AAC. Also writes OUT.wav. `--only voice/` keeps rows whose
#       asset path starts with the prefix. Synthesised sounds (blubs,
#       twinkle notes, plinks) have no file and are not in the log.
#
# Env: BB_BIN (default $CARGO_TARGET_DIR/debug/bouncy-blobs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/crates/bb-game/assets"
BIN="${BB_BIN:-${CARGO_TARGET_DIR:-$ROOT/target}/debug/bouncy-blobs}"

clip_secs() {
  ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1"
}

cmd="${1:-}"
shift || true
case "$cmd" in
  render)
    out="$1"; shift
    home="$(mktemp -d "${TMPDIR:-/tmp}/bb-capture-home.XXXXXX")"
    mkdir -p "$(dirname "$out")"
    env HOME="$home" BB_CAPTURE=1 BB_CAPTURE_OUT="$out" "$@" "$BIN"
    rm -rf "$home"
    test -s "$out"
    echo "rendered $out ($(clip_secs "$out") s)"
    ;;
  music)
    out="$1"; kind="$2"; secs="${3:-}"
    [ -n "$secs" ] || secs="$(clip_secs "$out")"
    case "$kind" in
      cave) track="$ASSETS/music/theme-cave.mp3" ;;
      bright) track="$ASSETS/music/theme.mp3" ;;
      *) echo "music: kind must be cave or bright" >&2; exit 2 ;;
    esac
    wav="${out%.*}.wav"
    ffmpeg -y -loglevel error -stream_loop -1 -i "$track" -t "$secs" \
      -af "afade=t=in:d=0.3,afade=t=out:st=$(python3 -c "print(max(0.0, $secs - 0.6))"):d=0.6" \
      -ar 48000 -ac 2 -c:a pcm_s16le "$wav"
    echo "music stem $wav ($kind, $secs s)"
    ;;
  mix)
    out="$1"; shift
    python3 -I - "$out" "$ASSETS" "$@" <<'PY'
import subprocess, sys
out, assets, args = sys.argv[1], sys.argv[2], sys.argv[3:]
with_music = "--with-music" in args
only = args[args.index("--only") + 1] if "--only" in args else None
dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out]).decode())
rows = []
for line in open(out + ".audio.tsv").read().splitlines()[1:]:
    start, end, gain, speed, loop, path = line.split("\t")
    is_music = path.startswith("music/")
    if is_music and not with_music:
        continue
    if only and not path.startswith(only):
        continue
    rows.append((float(start), float(end) if end else None, float(gain), float(speed), loop == "1", path))
rows = [r for r in rows if r[0] < dur and (r[1] is None or r[1] > 0)]
wav = out.rsplit(".", 1)[0] + ".wav"
cmd = ["ffmpeg", "-y", "-loglevel", "error"]
filt = []
for i, (start, end, gain, speed, loop, path) in enumerate(rows):
    if loop:
        cmd += ["-stream_loop", "-1"]
    cmd += ["-i", f"{assets}/{path}"]
    f = f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo"
    if abs(speed - 1.0) > 1e-3:
        f += f",asetrate={48000 * speed:.0f},aresample=48000"
    if start < 0:
        f += f",atrim=start={-start:.4f},asetpts=PTS-STARTPTS"
    # One-shots play out in full: their logged end is when the muted sink
    # finished in wall time, which a slow render stretches. Loops (music)
    # stop where the game stopped them.
    if end is not None and loop:
        f += f",atrim=duration={end - max(start, 0.0) if start >= 0 else end:.4f}"
    if start > 0:
        f += f",adelay={start * 1000:.0f}:all=1"
    f += f",volume={gain:.4f}[a{i}]"
    filt.append(f)
n = len(rows)
cmd += ["-f", "lavfi", "-t", f"{dur:.4f}", "-i", "anullsrc=r=48000:cl=stereo"]
filt.append("".join(f"[a{i}]" for i in range(n)) + f"[{n}:a]amix=inputs={n + 1}:normalize=0:duration=longest,atrim=duration={dur:.4f},alimiter=limit=0.95[mix]")
cmd += ["-filter_complex", ";".join(filt), "-map", "[mix]", "-c:a", "pcm_s16le", "-ar", "48000", wav]
subprocess.check_call(cmd)
tmp = out + ".mux.mp4"
subprocess.check_call(["ffmpeg", "-y", "-loglevel", "error", "-i", out, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", tmp])
import os
os.replace(tmp, out)
print(f"mixed {n} game clips into {out} (+ {wav})")
for r in rows:
    print(f"  {r[0]:7.3f}s  {r[5]}  gain {r[2]:.2f}")
PY
    ;;
  *)
    sed -n '2,30p' "$0"
    exit 2
    ;;
esac
