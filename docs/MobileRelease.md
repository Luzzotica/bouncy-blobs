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

## iOS → TestFlight

1. **Apple Developer team**: enroll / locate the Team ID (`ABCDE12345`).
2. **Wire the team into the project**:
   - `src-tauri/gen/apple/project.yml`: under `targets.app.settings.base`, add
     `DEVELOPMENT_TEAM: <TEAM_ID>` (and `CODE_SIGN_STYLE: Automatic`).
   - `src-tauri/gen/apple/ExportOptions.plist`: set `teamID` and
     `method` = `app-store-connect`.
3. **App Store Connect**: create the app record for
   `me.sterlinglong.bouncyblobs` (name "Bouncy Blobs").
4. **Certificates/profiles**: with automatic signing, Xcode manages these —
   open the generated project once (`npm run ios:dev` then open
   `src-tauri/gen/apple/app.xcodeproj`) and sign in.
5. **Build + upload**:
   ```sh
   npm run ios:build          # tauri ios build → .ipa (export method from ExportOptions.plist)
   xcrun altool / Transporter # or: xcodebuild -exportArchive upload, or drag into Transporter.app
   ```
6. **TestFlight**: add internal testers in App Store Connect; builds appear
   after processing (~10 min).
7. Store metadata when going public: privacy questionnaire (no tracking; anon
   device id + optional sign-in), screenshots per device class, age rating.

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

## Known pre-launch items (out of scope of the parity work)

- **`TODO(mobile-attestation)`** (`src/lib/partyConfig.ts`): mobile multiplayer
  auth currently rides the backend API-key fallback. Before the arcadii
  backend enables `ENFORCE_SESSION_TOKENS`, mobile needs a real attestation
  path (arcade SSO JWT via `window.__ARCADE_TOKEN__`, or a platform proof) or
  phone clients will be locked out of online play.
- **Native `confirm()/alert()/prompt()` probe**: ~22 call sites (editor list,
  MyReplays deletes, toolbar errors). Verify on a real iOS device that Tauri's
  WKWebView shows JS dialogs; if any are silently dropped, replace the
  mobile-reachable sites with a themed `ConfirmDialog` built on
  `modalBackdrop`/`modalCard` from `src/theme/uiTheme.ts`.
- **Device test matrix** (per release): Editor — place every tool, pinch-zoom,
  properties drawer, touch bar chips, Test Play round-trip (autosave +
  `?restore=1`); GameMaster — auto-join, pad in freeplay + match, stacked
  lobby, QR tap-to-copy; OnlineGuest — join, pad, stacked lobby; Home /
  PlayHub / Multiplayer / MyReplays on a notched device in both orientations.
