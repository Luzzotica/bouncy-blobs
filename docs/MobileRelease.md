# Mobile Release (iOS + Android) — Bevy port

The phone/tablet app is the **Bevy port** (`crates/bb-game` via `crates/bb-mobile`).
The old Tauri/WebView app (`src-tauri/`, `npm run ios:*`) is retired: never build
or ship it. Platform plumbing (Xcode project, Gradle project, asset paths) is in
`docs/Platforms.md`; this page is the release runbook and what was verified.

Uploads (TestFlight, Play internal) happen **only** in the nightly publish job.
Local and agent runs build, test and archive, and stop there.

## Versions

| Field | Where | Rule |
| --- | --- | --- |
| Marketing (`CFBundleShortVersionString`) | `ios/project.yml` `MARKETING_VERSION` (3.0.0) | Bumped by a human release, never by a build |
| Build (`CFBundleVersion`) | `ios/project.yml` `CURRENT_PROJECT_VERSION` (3.0.0.1), or `scripts/ios-build.sh --build 3.0.0.N` | Strictly greater than every build ever uploaded for this app. Apple treats missing parts as zero, so use `3.0.0.N` and bump `N` |
| Android `versionCode` | `BB_VERSION_CODE` (default 3000001) | Must increase every Play upload |

The 2.0.0.x builds on TestFlight were the Tauri app; 3.0.0.x are Bevy.

## Online / phone-controller key

`scripts/lib/mp-api-key.sh` (sourced by every build script, including
`ios/build-rust.sh`) bakes `BB_PARTII_KEY` and `BB_PARTII_API` into the binary
(`option_env!`):

1. `BB_PARTII_KEY` from the environment (CI secret, nightly job) wins.
2. `BB_STAGING=1`: `STAGING_BB_KEY` from `~/.config/partii/staging.env`, **paired
   with `STAGING_EDGE`** as `BB_PARTII_API`. A staging key against the production
   edge never connects ("Online play unavailable: could not reach partii").
3. Otherwise (the default, and what every release build uses): nothing is baked
   and the game uses the production key and edge in `crates/bb-net/src/config.rs`.

Both can be overridden at runtime (`BB_PARTII_KEY`, `BB_PARTII_API`), including
in the simulator via `SIMCTL_CHILD_…`.

## iOS

### Build for the simulator (headless)

Never open Simulator.app: boot devices with `simctl` only. Mute every run
with `SIMCTL_CHILD_BB_MUTE=1`. Keep **one** simulator booted at a time (each
takes about 1.5 GB). Cargo builds go through the machine-wide `rustq` queue
(`~/.rustq/README.md`). `build-rust.sh` builds into this checkout's `./target`,
so don't set `CARGO_TARGET_DIR` or profile flags. A queued build can wait for
minutes; run it in the background.

```sh
DD=/tmp/bb-xcode   # throwaway DerivedData; delete when done
xcodebuild -project ios/BouncyBlobs.xcodeproj -scheme BouncyBlobs -sdk iphonesimulator \
  -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath $DD build
APP="$DD/Build/Products/Debug-iphonesimulator/Bouncy Blobs.app"

DEV=$(xcrun simctl list devices available | grep -m1 'iPhone 17 (' | grep -oE '[0-9A-F-]{36}')
xcrun simctl boot $DEV && xcrun simctl bootstatus $DEV -b
xcrun simctl install $DEV "$APP"
SIMCTL_CHILD_BB_MUTE=1 xcrun simctl launch $DEV me.sterlinglong.bouncyblobs &
#   …plus SIMCTL_CHILD_BB_START=sandbox (a level) or =party (host + QR panel)
sleep 20; xcrun simctl io $DEV screenshot shot.png
xcrun simctl shutdown $DEV          # then boot the iPad and repeat; finally:
xcrun simctl shutdown all; rm -rf $DD
```

Notes from the first run (2026-10-15, Xcode 26.6, iOS/iPadOS 26 simulators):

* `simctl launch` can sit forever without returning even though the app is up.
  Background it and take the screenshot anyway.
* iPhone screenshots come out in the panel's portrait orientation. Rotate them
  270° to view (`sips -r 270`).
* iPadOS 26 runs this landscape-only app as a **landscape window letterboxed on
  the portrait screen**: the simulator can't be rotated headless. The window is
  about 1032×774 pt (4:3), which is the iPad layout we need to check. On a real
  iPad held landscape the app is full screen.
* The log is full of winit's `processing non RedrawRequested event after the
  main event loop: AboutToWait`. It is harmless. To read the game's own log:
  `xcrun simctl spawn $DEV log show --last 2m --predicate 'process == "BouncyBlobs"'`.

### Touch controls

Touch matches the phone controller (`web-controller/src/lib/joystickInput.ts`):

* **Left half**: a fixed square pad, bottom-left. A touch that starts on the
  left half is measured from the pad's centre, normalised by its half-size, and
  shaped by `input::shape_pad`, an exact port of `shapeJoystickInput`.
  Horizontal snaps to ±1 past 0.15. Vertical has three zones: inside the ±0.3
  centre band is 0 (pure left/right), above it is up, and below it is down.
* **Right half**: tap or hold to expand. A glowing button marks it.
* The pad is drawn in levels, story levels and party rounds. It is hidden in
  menus and the party lobby.
* Layout (`input::pad_layout`) keeps the controls clear of the notch
  (`platform::SAFE_SIDE`, 60 pt) and the home indicator
  (`platform::SAFE_BOTTOM`, 20 pt).

### Hosting a party from an iPad

Play → Party (or `BB_START=party`; the demo gate makes Party paid, so
debug runs add `BB_OWNED=1`) hosts a partii room and shows the join
panel: a QR code plus a five-letter code for
the controller join page (partii-hosted since game-polish 920a0b9). Phones join as controllers over
WebRTC. Info.plist has `NSLocalNetworkUsageDescription` because direct
Wi-Fi paths to the phones trigger iOS's local-network prompt. No extra
entitlement is needed: outgoing connections are allowed by default, and we
don't browse Bonjour.

### Device archive and IPA

```sh
scripts/ios-build.sh                    # CFBundleVersion from project.yml
scripts/ios-build.sh --build 3.0.0.N    # nightly: pass the next build number
# → build/ios/BouncyBlobs.xcarchive, build/ios/export/Bouncy Blobs.ipa
```

* Signing is automatic for team `74874V9Z5H`. The export uses
  `ios/ExportOptions.plist`: `app-store-connect`, destination `export`,
  "Apple Distribution", and `manageAppVersionAndBuildNumber = false`.
* The script regenerates the Xcode project with `xcodegen` when it is
  installed. The regenerated `project.pbxproj` names the worktree folder in a
  group. That change is cosmetic: don't commit it from a worktree.
* Upload (nightly job only): `scripts/ios-upload-testflight.sh` (altool with
  an ASC API key or Apple ID, or Transporter).

## Buying the full game on iOS (StoreKit 2)

The demo gate (`crates/bb-game/src/ownership.rs`) is the same on every
platform. Join is always free. Hosting, Party and Sandbox need the full game.
Kids Mode and Story chapter 1 are the free part. On desktop, Buy opens partii
checkout in the browser. Apple requires StoreKit for unlocking inside an
iPhone app, so on iOS Buy goes through the App Store instead:

1. Buy → `store::purchase()` → `bb_sk_purchase()` (Swift, `ios/StoreKitBridge/StoreKitBridge.swift`) shows Apple's sheet for product `me.sterlinglong.bouncyblobs.full`.
2. A verified `Transaction` arrives as `{"kind":"purchased","transaction":"<Transaction.id>"}`. Rust sends it with `acct.submit_receipt("appstore", {"transaction": id})`.
3. Only after `take_receipt()` is `Ok` does Rust call `bb_sk_finish(id)` (`Transaction.finish()`). On an error the transaction stays unfinished, and StoreKit delivers it again (`Transaction.unfinished` / `Transaction.updates`) on the next launch.
4. **Restore Purchases** (on the unlock page, iOS only) → `AppStore.sync()`, then each `Transaction.currentEntitlements` id for the product is submitted the same way. `claimed_by_another_account` is shown as "This purchase belongs to another partii account".
5. `owns("full")` turns true after partii accepts the receipt, and the locks lift live.

**Status:** the code is written. It is behind bb-mobile's `storekit` feature, which is off by default, so builds without it show "The App Store isn't available in this build yet." The Swift file type-checks and builds as a static library for the iOS SDK (arm64 device and simulator). `crates/bb-mobile/build.rs` compiles and links it when the feature is on. The full iOS app with the feature has not been linked and run on a device yet.

**TODO to turn it on:**

- [ ] **App Store Connect (blocker, Sterling):** create a non-consumable in-app purchase with Product ID `me.sterlinglong.bouncyblobs.full` (price tier matching the $5 partii listing), with a review screenshot, and attach it to the next app version. Also give partii what it needs to verify App Store receipts for bundle `me.sterlinglong.bouncyblobs`; ask partii-backend which App Store Server API key or issuer setup it uses for `playersReceipt`.
- [x] **iOS 15:** StoreKit 2 and Swift concurrency need iOS 15. Done: `deploymentTarget.iOS` in `ios/project.yml`, `IPHONEOS_DEPLOYMENT_TARGET` in `ios/build-rust.sh`, and both configs in the committed `project.pbxproj` (Xcode exports that value to the build script, overriding its default).
- [x] **Build flag:** `ios/build-rust.sh` builds with `-p bb-mobile --bin bb-mobile --features storekit`.
- [ ] Optional, for local testing: add a StoreKit configuration file (`BouncyBlobs.storekit`, with the same product id) to the Xcode scheme, to buy in the simulator without App Store Connect.
- [ ] Test on TestFlight with a sandbox Apple ID: buy, kill the app before partii answers (the purchase should come back on relaunch), Restore on a second device, and Ask to Buy (shows "Waiting for approval").

**Android:** Google Play requires Play Billing for digital goods in Play-distributed apps. For now, Buy on Android shows "Get the full game at partii.games". The same pattern (Play Billing → `submit_receipt(<Play store id>, {"purchase_token", "product_id"})` → acknowledge after Ok) is still to be done.

## Android

See `docs/Platforms.md` › Android (`scripts/android-build.sh`, GameActivity,
`--aab` for Play). Release signing:

1. Keystore (once; keep it out of git):
   ```sh
   keytool -genkeypair -v -keystore ~/keystores/bouncy-blobs.jks \
     -keyalg RSA -keysize 2048 -validity 10000 -alias bouncyblobs
   ```
2. `android/keystore.properties` (gitignored): `storeFile`, `storePassword`,
   `keyAlias=bouncyblobs`, `keyPassword`.
3. `scripts/android-build.sh --aab`, then upload to the Play *Internal testing*
   track (nightly job).
4. Data-safety form: WebRTC multiplayer (IPs processed transiently), anonymous
   device id, optional account sign-in; no ads, no tracking SDKs.

## Store metadata (when leaving TestFlight)

Privacy questionnaire (no tracking; anonymous device id plus optional sign-in),
screenshots for each device class (iPad Pro 13" is 2752×2064; see
`docs/AppStoreAssets.md`), age rating. Kids Mode is a local play mode (no ads,
no chat).

## Verification log

### 2026-10-15: first iPhone + iPad run of the Bevy port (branch `port-ios`)

Debug simulator build (`xcodebuild … -sdk iphonesimulator`), Xcode 26.6,
iOS/iPadOS 26.

| Check | iPhone 17 (874×402 pt) | iPad Pro 13" (M5), 4:3 window |
| --- | --- | --- |
| Builds, installs, launches, renders (Metal) | ✅ | ✅ |
| Title menu fits, clear of the Dynamic Island | ✅ | ✅ |
| Level (`BB_START=sandbox`): square + band pad bottom-left, glowing EXPAND button bottom-right, HUD counter | ✅ | ✅ |
| Party host (`BB_START=party`): room created, join panel shows the QR and a 5-letter code, lobby buttons clear of the panel | ✅ | ✅ |
| After merging game-polish: built with `--features storekit` (iOS 15 target). `bb_sk_*`, StoreKit.framework and the Swift runtime are linked; StoreKit queries transactions at launch; nothing crashes | ✅ | ✅ |

Fixed on the way:

* **Hosting failed** ("could not reach partii"): the build paired the staging
  key with the production edge. `mp-api-key.sh` now pairs it with
  `STAGING_EDGE`.
* **Party lobby on 4:3 and 19.5:9:** the join panel covered the lobby buttons.
  The buttons now form a column under the title, and on phones the join panel
  uses a 160 pt QR and puts the URL on its own line.
* **Touch:** the floating stick is gone (see Touch controls). The pad and the
  join hint respect `SAFE_SIDE` / `SAFE_BOTTOM`.

Not verified here: a real phone joining by QR (it can't be done headless), and
a physical device. The signed device archive (`scripts/ios-build.sh`, release +
LTO) was **deferred to the nightly window** under the machine's build protocol.
The last archive, from before the bevy-port merge, was signed `Apple
Distribution: Sterling Long (74874V9Z5H)` (see `docs/Platforms.md`).
