# Bouncy Blobs — Kids Mode (iPad)

> **2026-10-12:** The Steam launch is **October 30, 2026**. The cave is the public story. The king text on the Steam page is not what we post. The date is not on that page yet. He could not set it in Steamworks. Posts may still say "coming October 30." **Climb-2 version 9 is a pass.** Do not edit `climb-2.json`, `climb-1.json`, or `swing.json`. Bouncy Blobs content is un-paused. Launch is still October 30, 2026. Do not record the web game. First Rust clips are Kids Mode for the Bubbles video, then Pip bouncing in the ready biomes, and only after the Bevy capture mode exists. No Apple beta in public posts. Beats 5–8 are not started. The `bevy-port` branch is not this slice. Do not start the menu rebuild, the app rewrite, or the online rewrite. Do not mention the Apple beta in public posts.

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
- [x] **TF 2.0.0.9 Available** (ASC VALID / READY_FOR_BETA_TESTING) — *eng* confirmed 2026-07-21 ~03:09 UTC · Delivery `b613b950-7745-4bd3-b116-3f5aacf08f4a`
- [ ] **TF internal testers + install + device QA** — *Sterling* (`75073fea`) · **blocked**: Padii still **2.0.0.6** and **TestFlight app not on device** (tester cannot self-install beta); then *tester* matrix

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
- [ ] **Device walk-away / TF install** latest binary (**2.0.0.9**) — *Sterling* · install **TestFlight app** + Bouncy Blobs **2.0.0.9** on Padii (cable install of store binary fails; beta path required)

### 15. Sterling GO SHIP + Home sticky — *directed 2026-07-20*
- [x] Commit kids work · push GitHub (`mobile-port` + `main`) — *eng* · SHAs **6982db1** then **68d8b09**
- [x] Deploy web **PROD** (Vercel Ready) — *eng*
- [x] Publish **itch** html5 (#1812136 @ 2.0.0) — *eng*
- [x] Home: **Kids Mode below Multiplayer**, same size as other stickies (not hero) — *ui*
- [x] **TestFlight 2.0.0.9** upload — *eng* · Delivery `b613b950-7745-4bd3-b116-3f5aacf08f4a` · *await ASC Available*

### 16. Sterling P0 polish + kid-proof exit — *directed 2026-07-21*
- [x] Softer **color-green** sung clip regen — *eng* (web tree; **not** in TF 2.0.0.9)
- [x] Kids **grab hold-expand** (stay expanded while finger held/dragging) — *eng* (web tree; **not** in TF 2.0.0.9)
- [x] **Kid-proof Back** hold/long-press exit — *ui* · `KidsHoldBack` 1.5s progress (top-left); *eng* optional SFX/teardown
- [x] **Confirm TF 2.0.0.9 Available** in ASC/TestFlight — *eng* · Available · READY_FOR_BETA_TESTING (2026-07-21)
- [ ] **Next TF 2.0.0.10** (green + hold-expand + Back) for device parity — *eng* when Sterling asks

### 12. Sterling Padii dogfood / walk-away install — *directed 2026-07-19*
- [x] Production **walk-away install** on connected iPad (not tethered vite) — *eng* · **2.0.0.4** then **2.0.0.5**
- [x] Human: Developer Mode ON (Padii) — *Sterling* (was blocker; cleared)
- [x] **Landscape-only** Kids / iPad install (`Info.plist` / project.yml) — *eng*
- [x] **Immersive** hide status bar (time/battery) — *eng*
- [x] **Bottom chrome**: colors **between** stick + puff at **true bottom** (`KidsBottomBar`) — *ui* (+ eng merge)
- [x] **2.0.0.5 LIVE** walk-away on Padii (immersive + landscape + bottom bar) — *eng report just now*

## 17. The climb — Sterling, 2026-10-06

He asked for this whole game. The choice card was skipped, so these calls stand until he corrects them.

**The story.** You are a soft body. Your pack kicks you out. You climb out of a cave to find comfort, and true softness. A loving little girl finds you and whisks you away to play forever. Hope, joy, and a little silly. Nothing scary. She is a character we design, not a photo of his daughter. The old king story (`docs/Story.md`, Reginald Plopp) steps aside for this climb. Party modes stay until the climb is the main way to play.

**2026-10-12.** Sterling confirmed the cave is the public story. The Steam launch is October 30, 2026. The store page still says "Coming soon" and still tells the king story. Content is un-paused. Do not record the web game. First Rust clips are Kids Mode for the Bubbles video, then Pip bouncing in the ready biomes, only after the Bevy capture mode exists. The capture build is on branch `port-capture`. First Pip clips are estimated around 7 pm MDT on 2026-10-14. Kids Mode and Host with Phones (8 slots) are in the Rust game and are not on the polish-cut list. Whether they are in the October 30 Steam upload is Sterling's call. The level editor is being removed. Do not edit the web level files.

**The world.** The whole climb is soft bodies: ground, objects, ropes, and the things you tap. Blobs flying up can hit them. The home menu becomes soft bodies too. Kids-mode buttons stay big and steady so a toddler can still hit them.

**Already true, so we do not rebuild it first.** The bounce brain is already Rust (`crates/softbody`) and already runs in the browser and the iPad app. Menus, kids mode, level flow, and online play still live in the web app.

**Order.**

### Phase A — pops, platforms, ropes — *eng tests green; play pass open*
- [x] **Stretch pop stays local.** Stretch limit is now **5× rest radius** (`CRUSH_HULL_SPREAD_RATIO_SQ` 100 → **25**, ~25× area, same order as the 1/15-area squash). The old 10× hull was reset only after collisions, so it shoved neighbors first. Reset now happens before contact. Neighbor blob + platform keep their points and stay near rest size. `cargo test -p softbody`: 108 passed.
- [x] **Soft platforms stay solid with lots of points.** 64-point floor holds a bouncing blob for 10s. Stress through **640** points did not explode or tunnel (no hard failure count below that). **Safe / editor cap: 256** hull points (`clampRectSegments`); loader auto-clamps higher. Expand-inside tunnel tests stay green.
- [x] **Ropes hold in the sim.** Cause: chain solve moved the blob center, then the centroid pin threw that correction away, so segments ran away (thousands of units). Ends now move as a whole body, and the chain is solved again after the pin. Slack **10%** (`ROPE_SEGMENT_SLACK`). 10s tests: two soft bodies, and player vs fixed anchor.
- [x] **Play pass on Swing** — *PASS, level v6, 2026-10-07* · Disk and vite :5170 were version 6. Seat stayed a flat plank. Rope stayed 320. Seat rests at (500, 480). Steady rides lit Level Complete at 0:03.433 and 0:03.333 with 0 deaths. One hard ride finished at about (934, 472) after 2 pit falls. A later replay: a flat jump (apex y=241) hit the seat and pitted with no finish. A higher jump (apex y=260) landed on the seat, the seat swung, and the ride finished. No jump finished with the seat left at rest. That is not a reopen. A skip from the left ledge did not finish. A rougher hard ride flew over the box at about y=400 (box starts at y=430) and fell in the pit. That overshoot is a note for the climb, not a reopen. Stills: `agents/bouncy-blobs-tester/swing-pass-v5/`.

### Phase B — the climb you can play — *second room passed*

Story, unless Sterling corrects it. Hope and joy, a little silly. Nothing scary. The little girl is a character we design.

1. The pack. You bounce with the others. They push you out.
2. The way back is shut. The only way is up.
3. The first rope.
4. Darker caves. Soft floors and soft things you can bump.
5. Something kind helps you up.
6. Light from above.
7. The cave mouth. The ground is gentle. This is comfort.
8. A little girl finds you and takes you away to play forever.

- [x] **First room** — *PASS, version 7, 2026-10-07* · Three rides got on the seat and were still standing a second later: 0:02.466 at (1047, 460.3); hard 0:03.766 at (1022.3, 460.1); 0:02.316 at (1077.7, 460.2). 0 deaths. Skip peaked near (316, 374) and did not finish. Plank flat. Rope 320. Stills: `agents/bouncy-blobs-tester/climb-pass-v7/`. Disk is still that file. Do not edit it.
- [x] **Second room** — *PASS, version 9, 2026-10-07* · Three rides were still standing a second after Level Complete: 0:02.366 at (375.4, 399.2); hard 0:02.766 at (391.4, 399.4); 0:02.783 at (386.5, 400.7). 0 deaths. Skip peaked near (266, 274) and did not finish. Seat rests at (500, 410). Plank flat. Rope 320. Stills: `agents/bouncy-blobs-tester/climb-pass-2v9/`. Deck x 360–1480, top y=440. Finish x 370–1216, y 388–452. Version 8 is not a pass: all three lit and a second later were left of the deck, around x=380. Stills: `agents/bouncy-blobs-tester/climb-pass-2v8/`. Do not edit version 9. Do not put version 8 or version 7 back. Eng confirmed editing is stopped. The tester did not reload. File mtime 02:30:01.
- [ ] Beats 5–8, the scenes between levels, and the squishy home menu are next. They are not started.

### Phase C — one brain on every computer and phone — *after the climb plays*
- [ ] The game rules that still live in the web app move to Rust, so Mac, Windows, Linux, Android, and iPhone/iPad share one brain.
- [ ] Kids mode still works on each of those.
- [ ] Tests run on every target we can actually run here. A phone target is called out when a device is required.

### Phase D — online catch-up — *after C*
- [ ] Each device runs its own game. Nobody waits on another player's button.
- [ ] Up to 8 players. Send only what changed, packed small.
- [ ] The screen eases to the true spot, and jumps if it is too far. Local play owns the juice and the little animations.
- [ ] A phone can be a full player, not only a remote control.

## Non-goals (for the kids slice — section 17 overrides these for the climb)

- Full multiplayer kids lobbies (unless trivial)
- Kids mode does not become the cave story
- Do not rewrite menus, online play, or the app shell during Phase A

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
- [ ] Device/TestFlight kid-lens on **2.0.0.9** — *tester* **UNBLOCK when installed** on Padii (`75073fea`)
