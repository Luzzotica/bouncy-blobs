# Platforms: build, run, ship

Bouncy Blobs 3.0 is one Bevy 0.19 app (`crates/bb-game`) with three entry
points:

| Entry | Used by |
|---|---|
| `crates/bb-game/src/main.rs` (`bouncy-blobs` bin) | macOS, Windows, Linux, Web |
| `crates/bb-mobile` lib (`#[bevy_main]`, cdylib `libbb_mobile.so`) | Android (GameActivity) |
| `crates/bb-mobile/src/main.rs` (`bb-mobile` bin) | iOS (Xcode copies it into the `.app`) |

All per-platform differences live in `crates/bb-game/src/platform.rs`: the
window (desktop 1600×900 with a 1024×640 minimum, mobile borderless
fullscreen with hidden status bar and home indicator, web canvas `#bevy`), the
asset root, MSAA off on Android, and a startup **asset probe**. The probe loads
`assets/branding/icon.png` and logs `asset pipeline OK` or
`asset pipeline FAILED …`, so each platform's logs show whether assets load.

Identity (unchanged from the Tauri app): bundle and application id
`me.sterlinglong.bouncyblobs` (the Android debug build adds `.debug`), Apple
team `74874V9Z5H`. Marketing version **3.0.0**, from `[workspace.package]` in
`Cargo.toml`.

Export `CARGO_BUILD_JOBS=4` (or any value) to limit parallel jobs. Every
script respects it.

## Assets

Source: `crates/bb-game/assets/`. Paths passed to `AssetServer::load` are
relative to this folder on every platform.

| Platform | Where assets live at runtime | How they get there |
|---|---|---|
| `cargo run -p bb-game` | `crates/bb-game/assets` | Bevy uses `CARGO_MANIFEST_DIR` |
| bare `target/*/bouncy-blobs` | `crates/bb-game/assets` | fallback in `platform::asset_file_path` |
| macOS `.app` | `Contents/Resources/assets` | `scripts/build-macos.sh` |
| Windows / Linux zip | `assets/` next to the executable | CI packaging step |
| iOS | `BouncyBlobs.app/assets` | Xcode folder reference (Copy Bundle Resources) |
| Android | APK `assets/` root | `sourceSets.main.assets.srcDirs` in `android/app/build.gradle` |
| Web | `web/dist/assets/` (fetched relative to the page) | `scripts/web-build.sh` |

`BEVY_ASSET_ROOT=/some/dir` overrides the root on desktop. Web and Android
never request `.meta` files (`AssetMetaCheck::Never`). If we start using the
asset processor, revisit this.

## Cargo features

* `bb-game` uses Bevy with `default-features = false` and the `2d`, `ui`,
  `audio`, and codec features. These build on every target. On Linux, x11 and
  wayland are both compiled in, and winit picks one at runtime.
* `--features dev` adds `bevy/dynamic_linking` and `file_watcher`. It is for
  **desktop only**: never pass it for iOS, Android or wasm.
* wasm32 also gets `bevy/web` (browser time and scheduling) and `getrandom`
  0.3/0.4 with `wasm_js`. getrandom 0.3.4 and later needs no `RUSTFLAGS` cfg.
* Android also gets `bevy/android-game-activity` through `bb-mobile`.

## Desktop

### Dev

```sh
cargo run -p bb-game                      # debug-ish (opt-level 1, deps at 3)
cargo run -p bb-game --features dev       # + dynamic linking for fast relinks
cargo run -p bb-game --release
```

### macOS `.app`

```sh
scripts/build-macos.sh           # -> build/macos/Bouncy Blobs.app (universal)
scripts/build-macos.sh --run     # build, then launch it
scripts/build-macos.sh --zip     # + build/macos/BouncyBlobs-3.0.0-macos.zip
```

The script builds `aarch64-apple-darwin` and `x86_64-apple-darwin` in release
and combines them with `lipo`. It then writes `Info.plist` from
`macos/Info.plist` (version taken from `Cargo.toml`, build number from
`MACOS_BUILD_NUMBER`), adds `macos/BouncyBlobs.icns` (the legacy Tauri icon)
and `assets/`, and signs the bundle. The minimum macOS is 11.0.

**Signing:** ad-hoc by default, which only runs on this Mac or after the user
right-clicks Open. To distribute outside Steam:

```sh
MACOS_SIGN_IDENTITY="Developer ID Application: Sterling Long (74874V9Z5H)" scripts/build-macos.sh --zip
xcrun notarytool submit "build/macos/BouncyBlobs-3.0.0-macos.zip" --keychain-profile <profile> --wait
xcrun stapler staple "build/macos/Bouncy Blobs.app"
```

### Windows / Linux

```sh
cargo build --release -p bb-game --bin bouncy-blobs
# ship target/release/bouncy-blobs(.exe) + crates/bb-game/assets as ./assets
```

Linux build dependencies (Debian/Ubuntu):
`pkg-config libudev-dev libasound2-dev libwayland-dev libxkbcommon-dev libx11-dev libxcursor-dev libxi-dev libxrandr-dev`.
Release builds on Windows hide the console window (`windows_subsystem`).

CI (`.github/workflows/build.yml`) runs `cargo test --workspace` and a release
build on ubuntu, macos and windows. It uploads a Linux tar.gz, a Windows zip,
and the macOS universal `.app` zip.

## iOS

Prerequisites: Xcode 16 or later, the `aarch64-apple-ios` and
`aarch64-apple-ios-sim` rustup targets, and (optionally) `xcodegen`.

* `ios/project.yml` is the XcodeGen spec. **`ios/BouncyBlobs.xcodeproj` is
  generated from it and committed.** After editing the spec, run
  `(cd ios && xcodegen)`.
* The build phase **Build Rust (bb-mobile)** runs `ios/build-rust.sh`. It maps
  `PLATFORM_NAME`/`ARCHS` to `aarch64-apple-ios-sim` or `aarch64-apple-ios`,
  runs `cargo build -p bb-mobile --bin bb-mobile` (`--release` for any
  configuration except Debug) into the workspace `target/`, and `lipo`s the
  result into `$TARGET_BUILD_DIR/$EXECUTABLE_PATH`. This is the Bevy 0.19
  `examples/mobile` pattern: a Rust executable, no Objective-C shim, and rustc
  links the system frameworks. The script resets `PATH` and unsets `SDKROOT`
  so host build scripts link against macOS, not the iOS SDK.
* Resources: `crates/bb-game/assets` as a folder reference, `AppIcon` and
  `LaunchLogo` (from the Tauri project), and `LaunchScreen.storyboard`.
* Info.plist keeps the Tauri settings: iOS 14 minimum, arm64 and Metal
  required, status bar hidden, `UIRequiresFullScreen`, iPhone portrait and
  landscape, iPad landscape only, and `ITSAppUsesNonExemptEncryption = NO`.
  `MARKETING_VERSION = 3.0.0`, `CURRENT_PROJECT_VERSION = 3.0.0.1`.

Run on the simulator:

```sh
xcodebuild -project ios/BouncyBlobs.xcodeproj -scheme BouncyBlobs -sdk iphonesimulator \
  -configuration Debug -derivedDataPath target/xcode build
xcrun simctl boot "iPhone 17 Pro"
xcrun simctl install booted "target/xcode/Build/Products/Debug-iphonesimulator/Bouncy Blobs.app"
xcrun simctl launch --console-pty booted me.sterlinglong.bouncyblobs
```

On a device, open `ios/BouncyBlobs.xcodeproj` in Xcode, pick the device, and
press Run. Signing is automatic with team 74874V9Z5H.

Ship to TestFlight:

```sh
scripts/ios-build.sh --build 3.0.0.2   # archive + export -> build/ios/export/Bouncy Blobs.ipa
scripts/ios-upload-testflight.sh       # altool upload (ASC API key or Apple ID), or Transporter
```

Bump `--build` (CFBundleVersion) for every upload, or edit
`CURRENT_PROJECT_VERSION` in `ios/project.yml` and regenerate.
`ios/ExportOptions.plist` is the Tauri one: `app-store-connect`, export,
Apple Distribution, and `manageAppVersionAndBuildNumber = false`.

**Safe areas:** Bevy 0.19 has no safe-area API. The game view is full-bleed,
and the camera's `AutoMin` scaling keeps the play area visible. HUD and UI
must stay clear of the notch and home indicator by hand (pad about 50 pt) until
we add a safe-area query.

## Android

Prerequisites (**not installed on the dev Mac as of 2026-10-06**; see Status):

1. Android Studio, or the command-line tools, with SDK Manager packages
   **Android SDK Platform 36**, **Build-Tools**, **Platform-Tools** and
   **NDK (Side by side) 28.x**. The default location is
   `~/Library/Android/sdk`; override it with `ANDROID_HOME`.
2. JDK 17. Homebrew's `openjdk@17` works.
3. `cargo install cargo-ndk`, plus the rustup targets `aarch64-linux-android`
   and `x86_64-linux-android`. The script adds the targets.

```sh
scripts/android-build.sh             # debug APK, arm64-v8a + x86_64 (emulator)
scripts/android-build.sh --install   # + adb install + launch
scripts/android-build.sh --aab       # release App Bundle for Play
adb logcat -s RustStdoutStderr:V bevy:V
```

* `android/` is a Gradle project (AGP 8.10, Gradle 8.11 wrapper, compile and
  target SDK 36, min SDK 31 like Bevy's example) using **GameActivity 4.4.0**.
  That is the version `android-activity` 0.6 is written against.
  `MainActivity` loads `libbb_mobile.so` and hides the system UI.
* `cargo ndk … -o android/app/src/main/jniLibs build -p bb-mobile --lib`
  writes the `.so` files. The script runs this step for you.
* `versionName` comes from `Cargo.toml`. `versionCode` comes from
  `BB_VERSION_CODE` (default 3000001) and must increase for every Play upload.
* Release signing: create `android/keystore.properties` (gitignored) with
  `storeFile`, `storePassword`, `keyAlias=bouncyblobs` and `keyPassword`. The
  keystore recipe is in `docs/MobileRelease.md`: `~/keystores/bouncy-blobs.jks`.
* The launcher icons are the Tauri app's mipmaps and its adaptive icon
  (background `#fffae6`).

## Web

Prerequisites: the `wasm32-unknown-unknown` target. The wasm-bindgen CLI
**must match the `wasm-bindgen` crate pinned in `Cargo.lock`** (0.2.129 today).
The script uses `wasm-bindgen` from `PATH` if the version matches. Otherwise it
installs the matching CLI into `target/tools/wasm-bindgen-<ver>/`. It runs
`wasm-opt -Oz` (binaryen) when installed.

```sh
scripts/web-build.sh           # release -> web/dist (index.html, bouncy-blobs.js, _bg.wasm, assets/)
scripts/web-build.sh --dev     # unoptimised, quicker
scripts/web-build.sh --serve   # build + python3 http.server on :8080
```

`web/index.html` is the source page. It has a full-window `<canvas id="bevy">`
that Bevy fits to its parent, and it filters winit's "exceptions for control
flow" startup throw. Rendering uses WebGL2. Release output is about 31 MB
uncompressed and about 9 MB gzip (`_bg.wasm`). Serve the `.wasm` with gzip or
brotli. Any static host works. For Vercel or itch, upload `web/dist` as is: all
paths are relative.

Phones-as-controllers remain a separate web page and are not part of this
build.

## Verification status (2026-10-06, Apple M5, macOS 26.5, Xcode 17F113)

| Target | Status | Evidence |
|---|---|---|
| macOS dev (`target/debug/bouncy-blobs`) | ✅ runs; Metal adapter; `asset pipeline OK` | |
| macOS `.app` universal | see the summary in the platform commit | `scripts/build-macos.sh --run` |
| iOS simulator (iPhone 17 Pro, iOS 26) | ✅ `xcodebuild … iphonesimulator build` succeeds; app launches, renders the sandbox level; os_log shows `asset pipeline OK` | screenshot taken during porting |
| iOS archive + export | see the summary in the platform commit | `scripts/ios-build.sh` |
| Web (Chromium headless, WebGL2 via ANGLE/Metal) | ✅ canvas 1280×720 renders the level; `asset pipeline OK`; **0 console errors** | |
| Android | ⚠️ not built locally: `~/Library/Android/sdk` is empty (no SDK or NDK). The Gradle project and script are written. CI builds the APK on macOS runners | |
| Windows / Linux | `cargo check` cross-target results are in the platform commit; full builds run in CI | |

Known: the game logs `bevy_render::slab_allocator: Use-after-free: attempted to
copy element data for an unallocated key` on startup on every platform. This
comes from the game's mesh updates, not from platform code. It is logged
through `console.log`, so it doesn't count as a console error on web.
