# Bouncy Blobs 3.0 — The Bevy Port

**Status:** in progress on branch `bevy-port` (worktree `../bouncy-blobs-bevy`).
**Decision owner:** Sterling. Directed 2026-10-06.

## Decisions (locked)

| Topic | Decision |
|---|---|
| Engine | Rust + **Bevy 0.19**. Hard cutover: the TS/React app is frozen; no Kids Mode updates until 3.0 ships. |
| Physics | New **`bb-physics`**: f32 **XPBD** (small steps). Replaces the Q32.32 fixed-point crate — determinism is no longer needed. |
| Netcode | **Eventual consistency**, owner-authoritative. No input delay, no rollback, no lockstep. Up to 8 players. |
| Phones | Stay a **web controller page** (no install). Host speaks the existing Lobbii signaling + controller JSON protocol, so current phones work unchanged. |
| Online | Lobbii rooms/signaling/TURN (sterlinglong.me) over WebRTC — native (webrtc-rs) and web (browser RTC). `Transport` trait leaves room for an Epic Online Services backend later (EOS has no browser SDK, so it can't be the only path). |
| Steam | Achievements only (lobbies optional later). |
| Targets | macOS, Windows, Linux, iOS (Xcode project), Android, **Web** (wasm). Tests run headless everywhere. |
| Editor | Rebuilt in-game with **bevy_egui**; imports legacy level JSON. |
| Cutscenes | **In-engine softbody puppetry**: scripted actors, camera moves, speech bubbles, squash & stretch. |
| Modes | **Story campaign** (1–8 co-op) + **party modes** (race / KOTH / etc.) + **Kids Mode**. |
| Look | Everything is a softbody — terrain, props, and the menu buttons you tap. |

## Crates

```
crates/
  bb-physics/   XPBD softbody core. glam only. Headless tests.            ✅
  bb-level/     Level format (serde), legacy JSON importer, campaign data.
  bb-net/       Wire codecs, Transport trait, Lobbii signaling, WebRTC
                (native + wasm), phone-controller protocol.
  bb-game/      Bevy app (lib + desktop bin + mobile/web entry).
web-controller/ Slim web app for phones (carried over from the TS app).
```

## Physics: what changed and why

The old sim integrated stiff springs explicitly, so with many points or stiff
settings it went unstable. That's why dense platforms broke, ropes stretched,
and crushes cascaded.

* **XPBD small steps** (12 substeps × 1 iteration). Unconditionally stable;
  stiffness is set by *compliance*, not by how many points you add.
* **Bodies** are particles + edges + triangle areas + outline volume + shape
  matching. Blobs, soft platforms, jelly ground, props, and UI panels are all
  the same struct.
* **Home tethers.** Jelly terrain wobbles but stays put, at any resolution.
* **Pop limits.** Squash floor and stretch ceiling are *hard* constraints, so
  dynamic play (piles, being stood on, friends pulling a rope) can't pop
  anyone. A body pops only when geometry, a kinematic mover, or a pin keeps
  forcing it past a limit for `grace` seconds. Its neighbours get `immunity`,
  so **one crush never kills the people next to you**.
* **Ropes** use a global path-length constraint (one projection removes all
  excess length and pulls the tied bodies directly, even when wrapped around
  a peg) plus long-range attachments. Tested: under 1% stretch with a 3:1
  mass ratio swinging, under 2% when flung at 3000 px/s.

## Netcode: eventual consistency

* Each body has one **owner**. Your blob is owned by your machine (phone
  players by the host). World props, NPCs, and pickups are owned by the host.
* Everyone simulates everything locally, every frame, with zero input delay.
* Owners stream compact **body states** for what they own: centroid
  (quantised 1/16 px), velocity (1/8 px/s), angle (u16), expand scale (u8),
  and flags (≈14 bytes per body). Priority accumulators decide what is sent
  each packet. Sleeping bodies send nothing.
* Receivers **blend** their local body toward the owner's state: velocity
  matching plus positional error spread over ~150 ms, snapping if the error
  is more than 120 px. The local sim supplies the jiggle, so visuals stay
  smooth.
* Discrete gameplay events (pops, checkpoints, rope grabs, level changes) go
  on the reliable channel and are owner-validated.
* Budget for 8 players at 30 Hz: about 8 × 14 B × 30 ≈ 3.4 KB/s plus props,
  well under 10 KB/s per peer.

## Platform pipeline

| Target | How |
|---|---|
| macOS | `cargo bundle`-style `.app` via `scripts/build-macos.sh` (universal binary) |
| Windows / Linux | `cargo build --release --target …` (CI cross; zip artifacts) |
| iOS | `ios/BouncyBlobs.xcodeproj` builds the static lib via a script phase (Bevy mobile pattern) and runs on device and simulator. Keeps bundle id `me.sterlinglong.bouncyblobs` and the TestFlight train |
| Android | `android/` Gradle + `cargo-ndk`, GameActivity |
| Web | `wasm32-unknown-unknown` + `wasm-bindgen`, WebGL2 |
| Tests | `cargo test --workspace` (headless: physics, level, net codecs, game logic with `MinimalPlugins`) |

## Phases

1. ✅ `bb-physics` core + behavioural tests.
2. `bb-game` skeleton: render softbodies, player controls, camera, sandbox.
3. `bb-level` format + gameplay elements (checkpoints, springs, spikes,
   crushers, ropes/vines, wind, water, conveyors, one-ways, goals).
4. Story campaign: 10 long levels with checkpoints, cutscene system, story
   beats.
5. Softbody UI: title, menus, level select, pause.
6. `bb-net`: phones (Lobbii + WebRTC + controller JSON), then online
   eventual-consistency play.
7. Kids Mode port (colors, ABC/Music/Shapes, voice clips, grab, AI friends,
   hold-back exit).
8. Party modes. 9. Egui editor. 10. Platform builds + CI.
11. Remove the TS app (keep `web-controller/`).

The story bible is in [`Story.md`](Story.md).

## Editor & legacy levels

* `bb_level::legacy::import_legacy` converts v1 (TS app) JSON: y-down → y-up,
  scaled 2/3 to the 32 px blob. Lossy cases come back as notes
  (`import_legacy_with`). Pressure plates become `plate:<id>` story
  triggers; `movePoints` actions become movers whose `trigger` names the
  plates (`a|b` any, `a&b` all, `#toggle`, `#once`). bb-sim drives them.
* The 27 legacy levels are converted into `crates/bb-game/assets/levels/party/`
  (`cargo run -p bb-level --example convert_legacy`; a test fails if stale).
* In-game editor: `crates/bb-game/src/editor/` (`AppState::Editor`).
  `BB_START=editor BB_EDIT_LEVEL=<party id|map id|path>` boots into it.
  Maps live in `<data dir>/me.sterlinglong.bouncyblobs/maps-v3/` (web:
  localStorage). Dev hooks for screenshots: `BB_EDIT_SELECT=kind:i`,
  `BB_EDIT_TOOL=<name>`, `BB_EDIT_PLAY=<frame>`, `BB_EDIT_BACK=<frames>`.
