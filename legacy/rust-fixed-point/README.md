# softbody (deterministic fixed-point physics)

A standalone Rust crate that implements the bouncy-blobs softbody simulation
in Q32.32 fixed-point integers, with a wasm-bindgen wrapper so it can run in
the browser. The point: bit-exact determinism across x86 / ARM / wasm32, so
two clients running the same scenario reach the same state — the foundation
for trustworthy netplay.

## Layout

```
crates/
  softbody/                       # core sim, no floats at runtime
    src/{fx,math,rng,collision,constraints,shape_matching,types,layers,tuning,world}.rs
    build.rs                      # generates sin / atan LUTs at compile time
  softbody-wasm/                  # wasm-bindgen surface, depends on softbody
    src/lib.rs                    # SoftBodyWorldHandle + BlobHandle
```

JS-side glue (lives in `bouncy-blobs/src/physics/`):

| File | Purpose |
|---|---|
| `wasm/softbody_wasm.{js,d.ts,_bg.wasm}` | Built artifacts — emitted by `npm run build:wasm`. |
| `SoftBodyEngine.ts` | Interface both engines implement; game code programs against this. |
| `softBodyWorldRust.ts` | Wasm wrapper — production engine. |
| `softBodyWorld.ts` | Legacy TS float sim — fallback via `?engine=ts`. |
| `engineSelector.ts` | Runtime pick between the two via `?engine=` flag or `localStorage.bb_engine`. Default: `rust`. |
| `fxConvert.ts` | Canonical `f64 ↔ Fx` round-half-to-even, mirrors `Fx::from_f64` in Rust. |
| `desyncDetector.ts` | Wire into netcode post-tick hook; samples `engine.stateHash()` and flags peer divergence. |
| `wasm-demo.html` | Standalone "drop a blob on a floor" demo. |
| `netplay-determinism.html` | Two wasm worlds, same seed, same scripted inputs — asserts hashes match every tick. |

## Build commands

```bash
# Native Rust tests (unit + determinism)
cd crates && cargo test

# Wasm build → emits to bouncy-blobs/src/physics/wasm/
npm run build:wasm

# Browser demos
npm run dev
# then visit:
#   http://localhost:5170/src/physics/wasm-demo.html
#   http://localhost:5170/src/physics/netplay-determinism.html
```

## Determinism guarantees, in plain English

1. **Engine self-determinism** — `world::tests::two_worlds_same_seed_byte_identical_state`
   Two `SoftBodyWorld` instances given the same seed and identical inputs
   produce byte-equal `pos[]` and `vel[]` arrays after 60 steps including
   blob-vs-blob CCD. This is the netplay foundation: it doesn't matter
   *what* the state is, only that every client agrees on it.

2. **Cross-platform determinism** — implicit by construction.
   Because the sim does only integer arithmetic (no `f32`/`f64` anywhere
   in the hot path) and the LUTs are baked into the binary at build time,
   running the same compiled binary on x86-64 macOS, ARM macOS, wasm32 in
   Chrome, or wasm32 in Firefox produces the same bytes. Verify in the
   browser with `netplay-determinism.html`: it spins up two
   `SoftBodyWorldHandle`s in the same tab and shows their state hashes.
   To verify across browsers, open the page in each one and compare
   hashes at tick 600.

## Manual netplay-validation procedure (when you wire wasm into actual gameplay)

1. Open the game in two tabs, both with `?engine=rust`.
2. In one tab, host a lobby. In the other, join.
3. Play a 30-second match.
4. At the end, on both clients, call `world.stateHash()` from the devtools
   console and compare. If equal, the netplay-determinism story is intact.
   If not, log positions per blob and diff the first ones to diverge.

The wasm `stateHash()` is an FNV-1a 64-bit hash of every `(pos.raw,
vel.raw)` byte — comparing two of them is a single equality check on a
`BigInt`. Cheap enough to fire every keyframe (~once per second) and
trigger a desync warning UI when it disagrees.

## Game integration (Phase 6 — landed)

The Rust engine is now wired into the live `BouncyBlobsGame`. Flip
`?engine=rust` to play the game using the integer sim.

```bash
npm run build:wasm   # produces src/physics/wasm/* artifacts
npm run dev          # boot dev server
# open http://localhost:5170/?engine=rust  → game runs on Rust sim
# open http://localhost:5170/             → game runs on TS sim (default)
```

Architecture:
- `src/physics/SoftBodyEngine.ts` — interface both engines implement
- `src/physics/softBodyWorld.ts` — existing TS float sim (default)
- `src/physics/softBodyWorldRust.ts` — wasm wrapper (`?engine=rust`)
- `src/physics/engineSelector.ts` — `createSoftBodyEngine(config)` factory
- `src/physics/desyncDetector.ts` — netplay desync helper that hashes
  state every 60 ticks; wire into your netcode to detect divergence

`main.tsx` calls `prepareEngine()` before mounting so the wasm module
is loaded before the game tries to construct an engine.

### Netplay validation procedure (manual)

1. Start two clients on the same dev server:
   - Tab A: `http://localhost:5170/?engine=rust` (host)
   - Tab B: `http://localhost:5170/?engine=rust` (guest)
2. Host a lobby, join from the other tab.
3. Play for at least 60 seconds with active blob-blob collisions and CCD.
4. In the devtools console of each tab, run:
   ```js
   document.querySelector('canvas').__bb_game?.world.stateHash()
   ```
   (or equivalent — your access depends on how the engine reference is
   exposed). The two hashes should be **identical** at any tick where
   both clients have applied the same input set.
5. For automated detection, instantiate `DesyncDetector`, sample inside
   your post-tick hook, broadcast the resulting `DesyncSample` over the
   existing netcode channel, and call `detector.comparePeer()` on receive.
   `differ` returns means desync — log positions and ship a bug report.

### What's still TS-only (known gaps in the Rust wrapper)

These methods/properties are interface-required but stubbed on the
wasm wrapper. The game shouldn't hit them in the netplay path, but
they're worth knowing about:

- `addRopeChain` — throws. Ropes/chains aren't needed for ranked play.
- `mass[]` / `invMass[]` getters — return zero arrays (the wasm doesn't
  expose them yet). Only `actionManager` reads `invMass`, and only to
  check `=== 0` for the anchored-particle branch; that branch always
  takes the default in the Rust path.
- `setTick(n)` — warns and no-ops. Used by `OnlineGuest` for keyframe
  restore; on the Rust engine, the deterministic seed-and-replay path
  should make keyframe-driven tick alignment unnecessary.
- `fixedDt` getter — returns a hardcoded `1/60`. The wasm sim derives
  dt from `step(dt)` per call; nothing on the read path needs it.

- **Wasm size optimization** — the release artifact is 262KB. Running
  `wasm-opt -Oz` and dropping `Debug` derives would land it closer to
  100KB. Not urgent until binary size matters for page load.

- **Build-time LUT determinism hardening** — the sin/atan LUTs are
  generated by `build.rs` using host `f64::sin/atan`. Different glibc/
  musl/Apple libm could produce different LUT bytes by 1 ULP. Today this
  is fine because every client downloads the same compiled `.wasm`, but
  if we ever distribute pre-compiled binaries per platform, we should
  commit the LUTs as checked-in source files generated once on one
  machine.
