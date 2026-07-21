# Mobile Release Checklist (iOS + Android)

How to go from the `mobile-port` branch to installable TestFlight / Play Store builds.
Code-side parity (touch editor, host/guest pads, responsive UI, splash screens,
version sync) is done; everything below is credentials + store plumbing that
needs the Apple/Google developer accounts.

## Versioning (already wired)

- `src-tauri/tauri.conf.json` `"version"` points at `../package.json` — one
  source of truth. Android picks it up automatically (`build.gradle.kts` reads
  `tauri.properties`, written by the Tauri CLI from the config).
- iOS project files are committed with literal versions; after any bump run:
  ```sh
  node scripts/sync-version.mjs
  ```
  (The `bump-version` skill flow should run this for bouncy-blobs.)
- **Marketing version** = `CFBundleShortVersionString` (e.g. `2.0.0`).
- **Build number** = `CFBundleVersion` — must be **strictly greater** than every
  previously uploaded build for the same app. Apple treats missing components
  as zero, so `2` == `2.0.0` (cannot re-use). Prefer `2.0.0.N` or bump the
  patch of the build string when re-uploading the same marketing version.

### TestFlight train (kids QA vs physics re-TF)

| Build | Marketing | CFBundleVersion | Contents | Status |
| --- | --- | --- | --- | --- |
| **TF #1** | 2.0.0 | `2.0.0` | Kids Mode vertical slice (speech, color rail, pick-up) | **Uploaded** 2026-07-19 · Delivery `567f659e-9091-4b34-8eee-c809310f90e7` |
| **TF #2** | 2.0.0 | `2.0.0.2` | BB AppIcon + soft-platform expand P1 (local-surface deep-pen) | **Uploaded** 2026-07-19 · Delivery `f7df7b68-3e55-449f-951c-e479d139c74c` · IPA ~89 MB |

Next re-TF (build number must strictly increase):

```sh
# Marketing stays 2.0.0; Tauri --build-number N appends → CFBundleVersion 2.0.0.N
node scripts/sync-version.mjs --build 2.0.0.3   # keep source in sync
npm run ios:build -- --ci --build-number 3
# then: npm run ios:upload  (or altool with tankii ASC key)
```

## iOS → TestFlight

### Wired (code — do not re-ask Sterling for team enrollment)

| Item | Value |
| --- | --- |
| Bundle ID | `me.sterlinglong.bouncyblobs` |
| ASC app | Bouncy Blobs (created by Sterling) |
| Team ID | `74874V9Z5H` (Sterling Long — from local Xcode / pbxproj) |
| `DEVELOPMENT_TEAM` | `project.yml` + `app.xcodeproj` (both configs) |
| `CODE_SIGN_STYLE` | `Automatic` |
| Export | `ExportOptions.plist` → `method=app-store-connect`, `teamID=74874V9Z5H` |
| npm scripts | `ios:build` (ASC export), `ios:build:debug`, `ios:upload` |

If the Team ID ever changes, update **both**:
- `src-tauri/gen/apple/project.yml` → `targets.app_iOS.settings.base.DEVELOPMENT_TEAM`
- `src-tauri/gen/apple/ExportOptions.plist` → `teamID`
- then re-run xcodegen / `npm run ios:dev` once so pbxproj stays aligned
  (or edit `DEVELOPMENT_TEAM` in `app.xcodeproj/project.pbxproj` debug+release).

### Build .ipa

```sh
# From repo root (uses tauri.ios.conf.json beforeBuildCommand = build:mobile)
npm run ios:build
# → tauri ios build --export-method app-store-connect
# IPA lands under src-tauri/gen/apple/build/… or src-tauri/target/… (see build log)
```

First time on a machine:
1. Open Xcode → Settings → Accounts → add Sterling’s Apple ID (team `74874V9Z5H`).
2. Optional sanity: `open src-tauri/gen/apple/app.xcodeproj` → target app_iOS →
   Signing & Capabilities → Team selected, Automatic.
3. Need a **distribution** cert (automatic signing creates “Apple Distribution”
   when exporting for App Store). Local identity already present for
   development: `Apple Development: Sterling Long (628URCX593)`.

Debug / device install (not TestFlight):

```sh
npm run ios:build:debug   # --export-method debugging
# or: npm run ios:dev
```

### Upload path → TestFlight

```sh
# After a successful ios:build:
npm run ios:upload
# = bash scripts/ios-upload-testflight.sh [optional path/to.ipa]
```

Auth for `ios:upload` (one of):

**A. App Store Connect API key** (preferred for CI / non-interactive):

```sh
export ASC_KEY_ID=XXXXXXXXXX
export ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
export ASC_KEY_PATH=~/AuthKey_XXXXXXXXXX.p8
npm run ios:upload
```

**B. Apple ID + app-specific password**:

```sh
export APPLE_ID=you@example.com
export APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
npm run ios:upload
```

**C. Transporter.app** (GUI, no env vars):

```sh
open -a Transporter
# drag the .ipa from the ios:build output path
```

Then in App Store Connect → TestFlight → wait for processing (~10 min) →
add internal testers.

### Store metadata (when going public)

Privacy questionnaire (no tracking; anon device id + optional sign-in),
screenshots per device class, age rating. Kids Mode is a local play path
(no ads / chat) — see Kids Mode section below.

### TestFlight deliveries (2026-07-19)

| Train | Marketing / build | Contents | Delivery UUID |
| --- | --- | --- | --- |
| **#1** | 2.0.0 / `2.0.0` | Kids Mode slice | `567f659e-9091-4b34-8eee-c809310f90e7` |
| **#2** | 2.0.0 / `2.0.0.2` | BB AppIcon + soft-platform P1 | `f7df7b68-3e55-449f-951c-e479d139c74c` |

IPA path (latest): `src-tauri/gen/apple/build/arm64/Bouncy Blobs.ipa` (~89 MB).  
Export: `app-store-connect` / team `74874V9Z5H`. Upload: `altool` + tankii ASC key.

Next (human): App Store Connect → TestFlight → wait for processing → add
internal testers. Kids Mode: Home → Kids Mode → `/kids`.

### Human blockers (not eng)

- ~~ASC API key~~ — same-org tankii key works for altool uploads
- Internal tester emails in TestFlight
- Screenshots / listing copy when leaving TestFlight

## Android → Play internal track

1. **Release keystore** (once; keep it out of git — `~/keystores/` or a
   password manager):
   ```sh
   keytool -genkeypair -v -keystore ~/keystores/bouncy-blobs.jks \
     -keyalg RSA -keysize 2048 -validity 10000 -alias bouncyblobs
   ```
2. **`src-tauri/gen/android/keystore.properties`** (git-ignored; add to
   `.gitignore` if not already):
   ```properties
   storeFile=/Users/<you>/keystores/bouncy-blobs.jks
   storePassword=...
   keyAlias=bouncyblobs
   keyPassword=...
   ```
3. **`src-tauri/gen/android/app/build.gradle.kts`**: add a `signingConfigs`
   block reading `keystore.properties` and set
   `buildTypes.release.signingConfig = signingConfigs.getByName("release")`
   (the standard Tauri Android signing recipe).
4. **Build the bundle**:
   ```sh
   npm run android:build -- --aab
   # → src-tauri/gen/android/app/build/outputs/bundle/universalRelease/
   ```
5. **Play Console**: create the app (`me.sterlinglong.bouncyblobs`), upload
   the .aab to the *Internal testing* track, add tester emails.
6. Data-safety form: WebRTC multiplayer (IPs processed transiently), anonymous
   device id, optional account sign-in; no ads, no tracking SDKs.

## Splash screens (done, verify on device)

- iOS: `gen/apple/LaunchScreen.storyboard` — paper-cream background + centered
  `LaunchLogo` image set.
- Android 12+: `values-v31/themes.xml` (cream `windowSplashScreenBackground`
  + launcher icon); pre-12: cream `windowBackground` in `values/themes.xml`.

## Kids Mode (iPad entry point)

- **Route**: Home → **Kids Mode** sticky note → `/kids` (`src/pages/KidsMode.tsx`).
- **Feature path**: dedicated kids play (not multiplayer). Soft `default` arena,
  floating color rail, ABC-on-bounce speech, tap/drag blob pick-up.
- **Speech**: on-device Web Speech API (`src/utils/speak.ts`) — no cloud. iOS
  needs a first user gesture (`unlockSpeech`); voices load via `voiceschanged`.
- **Touch**: targets ≥ 64–72pt; pad via `TouchControls`; safe-area insets on
  back button, letter badge, and color rail.
- **QA on device**: landscape + portrait iPad; color tap speaks; bounce speaks
  A→B→C; grab/drag a friend blob speaks color + flings; leave route stops TTS.
- **Store note**: Kids Mode is a local play mode (no ads, no chat). Age rating
  / Kids Category questionnaire still a human gate in App Store Connect.
- **App Store assets path (iPad screenshots)**: **documented only** — do not
  generate full store art unless Sterling asks. Recipe, device sizes, Kids shot
  list, skill command, and output dirs live in **`docs/AppStoreAssets.md`**
  (skill: `games/.claude/skills/app-store-assets`). Lead sizes: iPad Pro 13"
  `2752×2064` → `marketing/app-store/screenshots/ipad-13/`.

## Known pre-launch items (out of scope of the parity work)

- ~~`TODO(mobile-attestation)`~~ **DONE (2026-07-14)**: mobile attests with an
  arcadii player JWT (`platform: "player"`), verified end-to-end against
  production — see `docs/MobileAttestation.md` for the model, the enforcement
  runbook, and the phase-2 device-integrity (App Attest / Play Integrity)
  upgrade path.
- **Native `confirm()/alert()/prompt()` probe**: ~22 call sites (editor list,
  MyReplays deletes, toolbar errors). Verify on a real iOS device that Tauri's
  WKWebView shows JS dialogs; if any are silently dropped, replace the
  mobile-reachable sites with a themed `ConfirmDialog` built on
  `modalBackdrop`/`modalCard` from `src/theme/uiTheme.ts`.
- **Device test matrix** (per release): Editor — place every tool, pinch-zoom,
  properties drawer, touch bar chips, Test Play round-trip (autosave +
  `?restore=1`); GameMaster — auto-join, pad in freeplay + match, stacked
  lobby, QR tap-to-copy; OnlineGuest — join, pad, stacked lobby; Home /
  PlayHub / Multiplayer / MyReplays / **Kids Mode** on a notched device in
  both orientations.
