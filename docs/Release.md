# Releasing Bouncy Blobs (desktop: Steam + partii)

The owner's spec is `~/.rustq/BUILD-MATRIX.md`. This page is how bouncy-blobs
does it. The Steam tooling is copied from tankii (`tankii-worlds/scripts/steam`).

| Variant | macOS | Windows | Linux (SteamOS) | iOS | Android |
|---|---|---|---|---|---|
| Full game | Steam 4485010 + partii | Steam + partii | Steam + partii | TestFlight (`scripts/ios-upload-testflight.sh`) | deferred |
| Demo | Steam (app TBD) | Steam | Steam | none | none |

**One binary per platform** serves everything: Steam full game, Steam demo and the
partii download. It's built with `--features steam`; outside Steam the Steam client
simply isn't found (`achievements.rs`: `Client::init_app(..).ok()`) and the game runs
on. The game decides Full vs demo from ownership (`ownership.rs`: partii purchase or
Steam license). `libsteam_api` always ships beside the executable, because the binary
links it dynamically and won't start without it.

## One command

```sh
git checkout <commit>                         # in this worktree, clean tree, pushed
scripts/release.sh request-box <commit>       # 1. ask the Luzz box for Windows + Linux
# ... wait for the box's reply (draft release release-<version>-<sha7>) ...
scripts/release.sh <commit> --dry-run         # 2. build + fetch + assemble + scan + VDFs, no uploads
scripts/release.sh <commit> --skip-mac-build  # 3. the real uploads (reuses the dry run's mac build)
```

Everything lands in `build/release/<sha7>/`:

| Path | What |
|---|---|
| `content/{macos,windows,linux}/` | exactly what each Steam depot ships (= the partii zip contents) |
| `partii/bouncy-blobs-<v>-<os>.zip` | the partii downloads |
| `leakscan.txt` | the scan of every file in `content/` |
| `VERSION.txt`, `steam-patch-notes.txt` | from the newest `CHANGELOG.md` section |
| `report.txt` | the nightly report lines |
| `box/` | the Windows/Linux binaries from the box |

Report lines (spec format): `bouncy-blobs <full|demo> <macos|windows|linux> <steam|partii>: uploaded <id/version> | skipped (<why>) | FAILED (<error>)`.

## The steps, one by one

1. **Preflight** (`release.sh`): HEAD is the commit, tracked files clean, no
   `CARGO_TARGET_DIR`, and none of `BB_STAGING`, `BB_PARTII_KEY`, `BB_PARTII_API`,
   `BB_CONTROLLER_URL` set (bb-net bakes them with `option_env!`; release builds use
   the built-in production edge + key, `scripts/lib/mp-api-key.sh`).
   `CHANGELOG.md`'s newest section must equal the Cargo.toml version. We don't bump
   versions here.
2. **macOS** (this Mac): `scripts/build-macos.sh --steam`: aarch64 + x86_64 release
   builds through the rustq queue, `lipo`, `Bouncy Blobs.app` with
   `Contents/MacOS/libsteam_api.dylib` (install name `@loader_path/…`, plus an
   `@executable_path` rpath from `bb-game/build.rs`). Ad-hoc signed, **no hardened
   runtime, not notarized**, same as tankii: Steam launches aren't quarantined and the
   overlay's `DYLD_INSERT_LIBRARIES` re-exec breaks under a hardened runtime.
   partii zips are downloaded through a browser, so they ARE quarantined: until we
   sign with a Developer ID and notarize, Mac players right-click > Open the first
   time. (Signing: `MACOS_SIGN_IDENTITY=… scripts/build-macos.sh --steam`, then
   `xcrun notarytool submit`; not wired in yet.)
3. **Windows + Linux** (Luzz box): this Mac never builds them (rustq refuses).
   `release.sh request-box` writes `box-request.md` and sends it with
   `k2 msg compiler::luzz.k2.dev --inbox-wake` (falls back to relaying via `games`
   while bouncy-blobs isn't connected to the box). The box needs `partii` checked out
   as a sibling of `bouncy-blobs` at the matching commit. Windows: `cargo xwin build
   --release --target x86_64-pc-windows-msvc -p bb-game --bin bouncy-blobs --features
   steam`. Linux: the same with plain `cargo build` inside the Steam Linux Runtime
   (sniper) SDK; `build.rs` adds RUNPATH `$ORIGIN` for `libsteam_api.so`. The box
   posts both binaries as a draft GitHub release `release-<version>-<sha7>`, which
   `release.sh` downloads with `gh`. It checks the PE subsystem (GUI) and the RUNPATH.
4. **Assemble** (`scripts/steam/assemble.sh <os> <build>`): macOS = the .app;
   Windows = `bouncy-blobs.exe` + `steam_api64.dll` + `assets/`; Linux =
   `bouncy-blobs` + `libsteam_api.so` + `assets/`. The Steam redistributables come
   from the `steamworks-sys` crate version in Cargo.lock. `steam_appid.txt` never ships.
5. **Leak scan** (`scripts/leakscan.py`, tankii's `u16check.py` approach): every file,
   `CLAUDE_CODE_`, `K2SO_`, `K2_HOOK`, `SSH_AUTH_SOCK`, `STAGING_` in ASCII + UTF-16;
   every secret value in `~/.config/partii/*.env` (reported by name); any `pk_` key
   other than bb-net's production key; any staging host other than the ones bb-net's
   `config.rs` compares against. **Any hit stops the release before any upload.**
6. **Steam** (`scripts/steam/upload.sh`): builds the app_build VDF from
   `scripts/steam/apps.env` and runs `steamcmd +run_app_build` as the builder account
   `acitozzul` with its cached login in `~/.steam-builder`. `SetLive` is always empty:
   **uploads go to no branch and are never set live**; Sterling sets builds live in
   Steamworks. A platform without a depot id is skipped with a note. The demo app
   gets the same content once `STEAM_DEMO_*` are filled in.
7. **partii** (`scripts/partii-upload.sh`): `partii builds upload bouncy-blobs
   --platform <os> --version <v> --channel stable --file <zip>` against
   **production** (`PROD_DEV_TOKEN` from `~/.config/partii/production.env`; never
   `bouncy-blobs-game.env`, which is staging). Live the moment it's uploaded. Then it
   keeps the new build + the previous one per platform and deletes older ones.
   partii has no release-notes field yet (CLI 0.2.1).
8. **Report**: `report.txt` + the Steam patch-notes block for the morning report.

## Windows C runtime

The Windows exe links the MSVC runtime dynamically (`VCRUNTIME140.dll`, plus the
`api-ms-win-crt-*` UCRT that Windows 10+ always has), exactly like tankii's builds, and
like tankii we ship only `steam_api64.dll` beside it. A PC without the VC++ 2015-2022
x64 redistributable can't start the game. Open decision: tick that redistributable in
Steamworks (Installation > Redistributables) and either ship an app-local
`vcruntime140.dll` in the partii zip or build Windows with a static CRT
(`+crt-static` for `x86_64-pc-windows-msvc` in the repo's `.cargo/config.toml`).

## Steamworks setup (Sterling)

What Steam shows for 4485010 today (builder `acitozzul`, `app_info_print`): one depot,
**4485011**, with no OS set and no builds yet; launch option `game.exe`. Needed before
the Steam upload can run:

1. **Depots**: set 4485011's OS to **Windows** (or make a new Windows depot), and
   create a **macOS** and a **Linux** depot. Put the ids in `scripts/steam/apps.env`.
   Publish the depot change (an unpublished depot answers "Access Denied").
2. **Launch options** (Installation > General): Windows `bouncy-blobs.exe`; macOS
   `Bouncy Blobs.app`; Linux `bouncy-blobs` with **Steam Linux Runtime 3.0 (sniper)**.
3. **Builder access**: Users & Permissions: give `acitozzul` *Edit App Metadata* and
   *Publish App Changes To Steam* on 4485010 (and the demo app when it exists).
4. **Demo**: send the demo app id + its depot ids; fill `STEAM_DEMO_*` in apps.env.

## Changelog

`CHANGELOG.md`: player-facing, plain language, one `## <version>` section per version,
newest first. `scripts/release-notes.sh version-txt` prints `VERSION.txt`;
`scripts/release-notes.sh steam` prints the BBCode patch-notes block.
