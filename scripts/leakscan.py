#!/usr/bin/env python3
"""Leak scan for release binaries (tankii's u16check.py approach, extended).

    python3 -I scripts/leakscan.py <file-or-dir> [...]

Scans every regular file (dirs recursively, .app bundles included) and exits
non-zero on ANY hit. A hit blocks the upload (BUILD-MATRIX.md).

Checks:
1. Environment names that only get into a binary when a build captured the
   build machine's environment: CLAUDE_CODE_, K2SO_, K2_HOOK, SSH_AUTH_SOCK,
   STAGING_; in ASCII, UTF-16LE and UTF-16BE.
2. Secrets: every value in ~/.config/partii/{staging,production,
   bouncy-blobs-game}.env (8+ chars), ASCII + UTF-16, EXCEPT values that are
   public by design and compiled in on purpose: the string literals in
   crates/bb-net/src/config.rs (production edge, production publishable
   key, the staging URLs the config compares against). Reported by NAME only;
   values are never printed.
3. Publishable keys: any `pk_…` other than bb-net's DEFAULT_KEY (a baked
   staging or foreign key).
4. Staging URLs: any http(s) URL containing "staging" that isn't one of the
   compared-against constants in config.rs.

Not detectable from the bytes: a baked BB_PARTII_API equal to the staging
constant (the linker may merge identical literals). scripts/release.sh guards
that by refusing to build with BB_STAGING / BB_PARTII_* set, and a staging
edge without the staging key (check 2) cannot talk to anything.
"""
import hashlib
import os
import re
import sys

NAMES = ["CLAUDE_CODE_", "K2SO_", "K2_HOOK", "SSH_AUTH_SOCK", "STAGING_"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_RS = os.path.join(ROOT, "crates", "bb-net", "src", "config.rs")
ENV_FILES = ["staging.env", "production.env", "bouncy-blobs-game.env"]


def encodings(s):
    return [("ascii", s.encode()), ("utf16le", s.encode("utf-16-le")), ("utf16be", s.encode("utf-16-be"))]


def public_literals():
    try:
        src = open(CONFIG_RS, encoding="utf-8").read()
    except OSError:
        sys.exit(f"leakscan: can't read {CONFIG_RS}")
    lits = set(re.findall(r'"([^"\\]{8,})"', src))
    return lits


def secrets(public):
    """(name, value) for every secret-looking env value not public by design."""
    out = []
    base = os.path.expanduser("~/.config/partii")
    for fn in ENV_FILES:
        p = os.path.join(base, fn)
        if not os.path.isfile(p):
            continue
        for line in open(p, encoding="utf-8", errors="ignore"):
            m = re.match(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)", line)
            if not m:
                continue
            v = m.group(2).strip().strip("'\"").rstrip("/")
            if len(v) < 8 or v in public or v.rstrip("/") in {x.rstrip("/") for x in public}:
                continue
            if v.startswith("/") or v.startswith("~"):  # file paths, not secrets
                continue
            out.append((f"{fn}:{m.group(1)}", v))
    return out


def files(args):
    for a in args:
        if os.path.isdir(a):
            for d, _, fs in os.walk(a):
                for f in sorted(fs):
                    p = os.path.join(d, f)
                    if os.path.isfile(p) and not os.path.islink(p):
                        yield p
        elif os.path.isfile(a):
            yield a
        else:
            sys.exit(f"leakscan: {a} not found")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    public = public_literals()
    secs = [(n, encodings(v)) for n, v in secrets(public)]
    pk_re = re.compile(rb"pk_[A-Za-z0-9_-]{8,}")
    # Rust packs string literals back to back (no NUL), so a regex runs into
    # the next literal. Blank the public config.rs literals out first, then
    # look for what's left: keys by their shape, staging by hostname only.
    pub_bytes = sorted((x.encode() for x in public), key=len, reverse=True)
    host_re = re.compile(rb"https?://[a-z0-9.-]*staging[a-z0-9.-]*")
    hits = 0
    scanned = 0
    for p in files(sys.argv[1:]):
        d = open(p, "rb").read()
        scanned += 1
        found = []
        for n in NAMES:
            for enc, b in encodings(n):
                c = d.count(b)
                if c:
                    found.append(f"{n} {enc}={c}")
        for n, encs in secs:
            for enc, b in encs:
                if b in d:
                    found.append(f"SECRET {n} ({enc})")
        blank = d
        for b in pub_bytes:
            if b in blank:
                blank = blank.replace(b, b"\0" * len(b))
        for k in sorted(set(pk_re.findall(blank))):
            found.append(f"publishable key other than bb-net DEFAULT_KEY ({k[:6].decode()}…)")
        for u in sorted(set(host_re.findall(blank))):
            found.append(f"staging URL not in config.rs: {u.decode(errors='replace')[:80]}")
        is_bin = d[:4] in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\x7fELF") or d[:2] == b"MZ"
        if is_bin or found:
            rel = os.path.relpath(p) if not os.path.relpath(p).startswith("..") else p
            print(f"{'HIT ' if found else 'ok  '} {rel}  sha256={hashlib.sha256(d).hexdigest()[:16]} size={len(d)}")
        for f in found:
            print(f"       {f}")
        hits += len(found)
    print(f"leakscan: {scanned} files, {len(secs)} secrets checked by name, {hits} hit(s)")
    sys.exit(1 if hits else 0)


if __name__ == "__main__":
    main()
