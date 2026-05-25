# Bouncy Blobs — Steam Release Checklist

Living document. Tick items off as they land. Sections roughly ordered by "do this first."

## In-Flight Right Now

Tracked in detail in `/Users/sterlinglong/.claude/plans/please-take-a-look-breezy-backus.md`:

- [ ] Phase A: Transport abstraction (refactor WebRTC behind `Transport` interface)
- [ ] Phase B: Steam Networking transport (`ISteamNetworkingSockets`)
- [ ] Phase C: Steam Lobbies for friend invites
- [ ] Phase D: Workshop browse + subscribe UI inside the game
  - [ ] Preview image picker in `PublishDialog`
  - [ ] Wire `workshop_list_subscribed` into level select
  - [ ] `workshop_subscribe`/`workshop_unsubscribe` commands
  - [ ] "Browse Workshop" button via Steam overlay

## Build & Release Infrastructure (the blockers)

- [ ] **macOS code signing + notarization** — no config in `tauri.conf.json` today. Need Apple Developer account, `bundle.macOS.signingIdentity` + `APPLE_ID` env vars. Without this the .app won't run on anyone else's Mac.
- [ ] **Windows code signing** — unsigned .exe gets flagged by SmartScreen and most AV. Need code-signing cert (EV cert ~$300–500/yr, regular ~$100–200/yr).
- [ ] **CI pipeline** — `.github/workflows/` doesn't exist. GitHub Actions matrix build (mac + win + linux) → sign → notarize (mac) → upload to Steam depots via `steamcmd`.
- [ ] **Bump version** from `0.1.0` in `package.json` and `tauri.conf.json` and pick a scheme (semver vs dated).
- [ ] **Steam branches** — set up `default` (public) and `beta` (opt-in testers) before launch so we can validate signed builds with a small group.
- [ ] **Crash reporting** — Sentry (or similar) for JS layer; `panic::set_hook` for Rust. Without this we'll get bug reports with no repro.

## Steam Platform Plumbing

- [ ] Steam Networking (in flight — Phase B)
- [ ] Steam Lobbies + friend invites (in flight — Phase C)
- [ ] Steam Workshop browse + subscribe (in flight — Phase D)
- [ ] **Steam Achievements** — define ~20–40 in the partner backend; unlock via `steamworks::UserStats`. Design them *before* code so they shape campaign objectives.
- [ ] **Steam Stats / Leaderboards** — cheap with steamworks. Good for replay (fastest classic time, longest survival, etc.)
- [ ] **Steam Cloud saves** — partner-backend toggle + file pattern. Trivial when local saves live in a known dir. Big UX win.
- [ ] **Steam Input** — currently using browser gamepad API. Steam Input adds free rebinding UI, native Steam Deck config, gyro/PS5/Switch Pro mappings. Strongly recommended for a party game.
- [ ] **Steam Overlay test on Windows** — Tauri + overlay has known gotchas; must verify it draws over the webview window.
- [ ] **Steam Rich Presence** — "In Lobby (3/4)", "Playing Classic on Blob Hill". Small touch, high perceived polish.
- [ ] **Steam Deck verification** — submit for Verified/Playable after launch. Test at 1280×800, controller-only nav through every screen including editor.

## Single-Player Content & Campaign

- [ ] Decide campaign structure (chapters? puzzle levels? challenge runs with star ratings?)
- [ ] Design ~12–20 levels for a campaign spine, leveraging Story.md's King Reg / Plopptopia framing
- [ ] Level-select UI with locked/unlocked progression
- [ ] Per-level objectives (e.g. "finish in <30s", "no falls", "collect all X")
- [ ] Star/medal system + end-of-level summary screen
- [ ] Tutorial / first-run experience (2 min, teaches movement + goal)
- [ ] King Reg voice-line recording (Story.md is the brief; pick a VO actor — Fiverr / CCC / friend)

## Audio

- [ ] Music tracks — `public/sfx/` has 17 effects but **no music**. Need menu theme, gameplay loops, victory/defeat stingers, editor ambient. License-clean (no YT rips). Pixabay free or commission ~$200–500.
- [ ] Achievement-unlock SFX
- [ ] Level-complete fanfare
- [ ] Menu nav clicks for new flows

## Visual Polish (the "match the menu" pass)

- [ ] Pause menu, settings modal, game-over screen, lobby UI, editor chrome — unify with menu's hand-drawn / sticky-note aesthetic
- [ ] Particle/decal language consistent with menu illustration
- [ ] Font choice consistent throughout
- [ ] Empty-state art: Workshop browser with no items, lobby browser with no rooms, no-controller-detected screen
- [ ] In-game HUD pass (currently functional/minimal; menu is illustrated)

## Settings & Accessibility

- [ ] Key/button rebinding UI (Steam Input gives this for free)
- [ ] Resolution / fullscreen / windowed / vsync (Tauri window APIs)
- [ ] **Colorblind mode** or alternate blob shapes/icons — party game = many similar-colored blobs = real problem
- [ ] Text scaling (Deck + TV play)
- [ ] Subtitle/caption toggle for King Reg narration
- [ ] Reduce-motion option (lots of shake + particles today)
- [ ] Pause-on-focus-loss behavior (critical SP; complicated for online)
- [ ] React error boundary — currently a render throw kills the app

## QA Pre-Submission

- [ ] Full controller pass — Xbox, PS, Switch Pro, generic
- [ ] Low-spec / integrated graphics perf pass — physics scales with blob count
- [ ] Steam Deck pass — handheld 800p, controller-only nav through every screen
- [ ] Workshop round-trip — publish a map on account A, subscribe + play on account B
- [ ] Disconnect chaos test — pull network mid-game, mid-lobby, mid-publish
- [ ] Steam offline mode — game must launch + play SP without internet
- [ ] Multi-monitor / window-resize / minimize during game / alt-tab while in lobby

## Steam Store Page

- [ ] Capsule art (5 sizes: small, header, main, library hero, library logo — exact Steam pixel specs)
- [ ] Screenshots (5–10, 1920×1080, showing variety: chaos, editor, phone play, art style)
- [ ] Trailer (30–90s, hook in first 6s, gameplay-forward, no logo waste)
- [ ] Short description (≤300 chars)
- [ ] Long description (markdown + embedded gifs)
- [ ] Tags (Local Co-op, Party Game, Physics, Level Editor, Workshop, etc.)
- [ ] System requirements (fill in honestly after perf pass)
- [ ] Age rating via IARC questionnaire (free, ~15 min in Steamworks)
- [ ] Privacy policy + EULA URLs

## Launch Strategy

- [ ] Decide: Early Access vs 1.0 (EA defensible given online stability is recent, but requires sustained update cadence)
- [ ] Pricing — comparable physics/party games run $7.99–$14.99
- [ ] Demo build for Steam Next Fest (biggest indie wishlist driver)
- [ ] Define demo-quality cutoff (which maps, editor enabled/disabled, modes available)
- [ ] Devlog cadence (Twitter/Bsky/YouTube), small-streamer outreach 2–3 weeks pre-launch
- [ ] Reddit posts (r/IndieDev, r/IndieGaming)

## Won't Do (for now)

- ~~Switch port~~ — user explicitly out of scope for v1
- ~~Mobile native port~~ — phone-as-controller via browser covers this use case
- ~~Online matchmaking with strangers~~ — friend invites only (via Steam Lobbies)

---

## Done

- [x] Steam app ID provisioned (4485010)
- [x] Steam partner tax/bank setup
- [x] `steamworks` Rust crate integrated, callbacks pumping
- [x] Workshop publish + update flow (PublishDialog → Rust → Steam)
- [x] Local maps storage (`~/.appdata/maps/`) with workshop_id linking
- [x] WebRTC phone-as-controller party play (host PC + multiple phones)
- [x] 11 hand-authored maps, 6 game modes, 12+ AI personalities
- [x] Level editor with Workshop publish hooks
- [x] Story.md creative brief for King Reg / Plopptopia
- [x] Playwright e2e suite (13 specs)
