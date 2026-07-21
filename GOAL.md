# Bouncy Blobs — Kids Mode (iPad)

## Mission

Ship a **gorgeous, simple kids mode** for Bouncy Blobs that works great on **iPad (and iOS)**, is easy for toddlers/preschoolers to use, and is **buildable + deployable** for App Store / TestFlight.

## Goal state (definition of done)

When this is done, a parent can put an iPad in a kid’s hands and:

### 1. iPad-first play
- [x] Game runs well on **iPad** (touch, landscape + portrait as appropriate, safe areas, no tiny hit targets) — *code ready: safe areas, ≥64pt targets, touch pad, no hover; physical device QA still recommended*
- [x] iOS/iPad app path is prepared: Tauri mobile build scripts (`ios:dev` / `ios:build`), icons, signing checklist (`docs/MobileRelease.md` Kids Mode section); TestFlight still needs human certs
- [x] Touch UX does not assume mouse hover

### 2. Color picker — tap your color
- [x] Kids can **tap large color targets** to choose “their” color
- [x] Color chips **float above the level** — big, high-contrast, easy to hit with a finger
- [x] UI is **simple** (no dense menus); cream-paper / Bouncy Blobs brand (skills `bouncy-blobs-ui` + `bouncy-blobs-style`)

### 3. Bounce says the ABCs
- [x] When the kid’s blob **bounces**, the game **speaks letter progression** (A, B, C… cycling or advancing — pick a clear, fun rule and document it)
- [x] Works offline on device (prefer on-device TTS / speech synthesis or short bundled voice clips — no cloud dependency for core loop)

### 4. Tap-to-expand / pick-up blobs (home-screen-like)
- [x] Level has **many other blobs**
- [x] Kid can **tap/drag a blob** to pick it up / expand it (similar energy to the home-screen blob interaction)
- [x] Every time they pick up / interact, the game **says that blob’s color**

### 5. Color change announces color
- [x] Whenever the player **changes color**, the game **speaks the color name** clearly

### 6. Build · deploy · store prep
- [x] Mobile build scripts green: `ios:build --export-method app-store-connect` → IPA; `ios:upload` path documented
- [x] First TestFlight upload **SUCCEEDED** (2026-07-19): v2.0.0 IPA → ASC Delivery UUID `567f659e-9091-4b34-8eee-c809310f90e7` (team `74874V9Z5H`, same-org tankii ASC API key) — **hold for kids QA**
- [x] Soft-platform expand P1 + BB icons in TF **2.0.0.2** — Delivery UUID `f7df7b68-3e55-449f-951c-e479d139c74c` (2026-07-19)
- [x] App Store assets path known (`app-store-assets` skill) — *docs/AppStoreAssets.md + MobileRelease pointer; full art only when Sterling greenlights post-TF*
- [x] Release checklist updated for kids mode entry point from home (`docs/MobileRelease.md`)
- [x] Human gates (Apple team, ASC) — *team wired; ASC app live; first build processing in TestFlight (~10 min) then add internal testers*

### 7. Sterling P0 kids v2 (web first, then TF) — *directed 2026-07-19*
- [x] Offline **bundled voice clips** (ElevenLabs pack under `public/sfx/kids/`; regen `scripts/generate-kids-voice.sh`) — *eng; docs/KidsVoice.md*
- [x] **ABC letter only on player expand** rising edge (not land/bounce) — *eng*
- [x] Color rail **bottom**, full-width, smaller chips — *ui* (+5px gap polish)
- [x] **Alphabet + Music** modes (picker chrome + expand → letter clips | Twinkle notes) — *ui chrome + eng wire*
- [x] Dia polish pass — *no welcome; louder music + note/letter VFX; badge unclip; user-select none* (ui+eng)

### 8. Sterling P0 kids v3 (daughter-driven, web first) — *directed 2026-07-19*
- [x] **Sung** letters + colors (ElevenLabs regen) — *eng*
- [x] **Side-tap** empty left/right = move — *eng*
- [x] Custom **kids map** + full-view camera — *eng*
- [x] **Shape mode** (expand/NPC → Star/Square/Triangle) — *ui picker + eng wire*
- [x] **Face row** under colors — *ui shipped; later **removed** per Sterling screenshot polish §11*
- [x] **AI friends** wander but stay tappable — *eng*
- [x] Kids v3 Dia-ready report (web) — *eng+ui handoff 2026-07-19*

### 9. Gates (web approve → QA → TF)
- [x] **Sterling playtest** approval (web) — *Sterling* · feedback `62c86918` **resolved** + **GO SHIP** directed 2026-07-20
- [x] **Tester kid-lens re-pass (web prod + itch)** — *tester* · **PASS** 2026-07-21 (REPORT.md; no S0/S1); device matrix still gated on TF Available
- [x] **Re-TF** (CFBundleVersion **2.0.0.9**) — *eng* · **SUCCESS** Delivery UUID `b613b950-7745-4bd3-b116-3f5aacf08f4a` (Distribution signed; `fea02972` resolved)
- [x] **TF 2.0.0.9 ASC status** — *eng* 2026-07-21: build **VALID**; was blocked **MISSING_EXPORT_COMPLIANCE** → set `usesNonExemptEncryption=false` → **internalBuildState READY_FOR_BETA_TESTING** (installable via TestFlight for Sterling/internal)
- [ ] **TF install + device QA** — *Sterling* install **2.0.0.9** (or **2.0.0.10** when processing) on Padii then *tester* device matrix

### 10. Sterling P0 kids v3.1 polish (web first) — *directed 2026-07-19*
- [x] **Fix sung clips** — no literal `[singing…]`; bare word clips — *eng Dia-ready*
- [x] **Pure playground** — drop single-player chase feel; kids-playground full-view — *eng*
- [x] **Space expands ALL blobs** at once (one lesson voice) — *eng*
- [x] Keep AI roam + shapes/colors (faces later removed in §11) — *eng*

### 11. Sterling screenshot polish P0 (web first) — *directed 2026-07-19*
- [x] First pass shipped (slim rail, shape rounding, no face UI, phonetics attempt, note VFX, platforms, AI expand) — *eng+ui*
- [x] **§13/§14 retest (web path)** — Sterling **GO SHIP** + `62c86918` resolved; device dogfood still nice-to-have when hardware online

### 13. Sterling kids polish retest (screenshot ~12:31) — *routed 2026-07-19 via tankii-producer → this PoC*
- [x] **More bottom space** for shapes — *ui* slim KidsBottomBar (joy/puff/chips smaller; strip maxHeight 58)
- [x] **Less bezier rounding** — square/triangle more obvious — *eng* (in 2.0.0.6 pack)
- [x] **Remove face changing** — *ui* confirmed none on Kids Mode
- [x] **Singing phonetics A, E, H, P, U, Y** force-regen — *eng* (in 2.0.0.6 pack; Sterling must verify)
- [x] **Music notes more random** around player — *eng* (in 2.0.0.6 pack)
- [x] **Remove bottom two platforms** — *eng* (in 2.0.0.6 pack)
- [x] **NPCs expand** like main-game AIs — *eng* (in 2.0.0.6 pack)
- [x] Rebuild + **Padii walk-away reinstall** — *eng* · **2.0.0.6** was LIVE; later **2.0.0.7/2.0.0.8** builds (device offline)

### 14. Sterling P0 mode-owns-taps + silence (web + device) — *directed 2026-07-20*
- [x] **Color mode** in picker (fourth sticky ⬤) — *ui* chrome DONE
- [x] **Mode owns ALL taps** — Music=music anywhere; ABC=next letter on any NPC tap; Shape=shape; Color mode=colors — *eng* in **2.0.0.7+**
- [x] **Stop ALL kids audio** on app background/close (iOS + web) — *eng* in **2.0.0.7+**
- [ ] **Device walk-away / TF install** latest binary — *tester*/*Sterling* · **2.0.0.9 READY_FOR_BETA_TESTING**; **2.0.0.10** packs hold-back+green+grab-hold

### 15. Sterling GO SHIP + Home sticky — *directed 2026-07-20*
- [x] Commit kids work · push GitHub (`mobile-port` + `main`) — *eng* · SHAs **6982db1** then **68d8b09**
- [x] Deploy web **PROD** (Vercel Ready) — *eng*
- [x] Publish **itch** html5 (#1812136 @ 2.0.0) — *eng*
- [x] Home: **Kids Mode below Multiplayer**, same size as other stickies (not hero) — *ui*
- [x] **TestFlight 2.0.0.9** upload — *eng* · Delivery `b613b950-7745-4bd3-b116-3f5aacf08f4a` · ASC **VALID** + export compliance cleared → **READY_FOR_BETA_TESTING**

### 16. Sterling P0 polish + kid-proof exit — *directed 2026-07-21*
- [x] Softer **color-green** sung clip regen — *eng*
- [x] Kids **grab hold-expand** (stay expanded while finger held/dragging) — *eng*
- [x] **Kid-proof Back** hold ~1.5s (`KidsHoldBack`) — *eng* · leave also silences kids audio (teardown + visibility/pagehide/blur)
- [x] **Confirm TF 2.0.0.9** — *eng*: VALID; was MISSING_EXPORT_COMPLIANCE → fixed → READY_FOR_BETA_TESTING
- [ ] **TF 2.0.0.10** upload (green + hold-expand + Back + `ITSAppUsesNonExemptEncryption=false`) — *eng* in flight

### 12. Sterling Padii dogfood / walk-away install — *directed 2026-07-19*
- [x] Production **walk-away install** on connected iPad (not tethered vite) — *eng* · **2.0.0.4** then **2.0.0.5**
- [x] Human: Developer Mode ON (Padii) — *Sterling* (was blocker; cleared)
- [x] **Landscape-only** Kids / iPad install (`Info.plist` / project.yml) — *eng*
- [x] **Immersive** hide status bar (time/battery) — *eng*
- [x] **Bottom chrome**: colors **between** stick + puff at **true bottom** (`KidsBottomBar`) — *ui* (+ eng merge)
- [x] **2.0.0.5 LIVE** walk-away on Padii (immersive + landscape + bottom bar) — *eng report just now*

## Non-goals (for this slice)

- Full multiplayer kids lobbies (unless trivial)
- Android (nice-to-have after iPad)
- Rewriting the entire game — prefer a **dedicated kids mode / play path**

## Product principles

1. **One-finger fun in under 5 seconds** — no reading required  
2. **Huge touch targets** — colors float above playfield  
3. **Voice is the teacher** — colors + ABCs  
4. **Gorgeous but simple** — sticky-note brand, not clutter  
5. **Ship on iPad** — not desktop-only polish  

## Team

| Agent | Role |
| --- | --- |
| **bouncy-blobs-producer** | PoC / manager — drives goal, unblocks, 15‑min progress checks |
| **bouncy-blobs-game** | Engineer — implement mode, speech hooks, physics/input, iOS build wiring |
| **bouncy-blobs-ui** | UI — gorgeous simple kids UI; floating color chips |
| **bouncy-blobs-tester** | Playtester — kid-lens QA on iPad sizes / touch |

Project: **Bouncy Blobs Kids**  
Code: `games/bouncy-blobs/`  
Skills: `bouncy-blobs-ui`, `bouncy-blobs-style`, `app-store-assets`, `docs/MobileRelease.md`

## Suggested implementation sketch (team may refine)

1. Entry: Home → **Kids Mode** (big button)  
2. Kids scene: soft playfield + many colored blobs + **floating color rail** above  
3. Input: tap color → set player color + speak color; tap/drag blob → expand/pick + speak color; bounce event → speak next ABC letter  
4. Speech: central `speak(text)` helper (Web Speech API on web/iOS WKWebView; fallback sounds)  
5. iPad: touch targets ≥ 44–64pt; test 1024×768 and modern iPad resolutions  

## Progress tracking

Producer heartbeat every **15 minutes** during work hours: score checklist above, unblock eng/ui/tester, escalate human gates.

## QA status (2026-07-21)
- [x] Kid-lens web/itch PASS (tester) — prod Vercel + itch #1812136
- [ ] Device/TestFlight kid-lens on **2.0.0.9** — *tester* standby until TF Available + install on Padii (`75073fea`)
