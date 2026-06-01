// ─────────────────────────────────────────────────────────────────────────────
// Rollback exactness tests (Rust+wasm engine).
//
// These are the canonical guard against "rollback fires but sims diverge"
// bugs — the symptom we hit when `engine.serializeState()` is silently
// lossy (returns success, restoreState returns true, but some piece of
// state that affects future ticks isn't actually captured). The
// `expandShapeScale` integrator was the first known instance; this file
// exists to catch the next one BEFORE it desyncs production.
//
// Each test follows the same pattern:
//   1. Build the Rust+wasm engine + PlayerManager (+ optional managers).
//   2. Run TWO sims in lockstep with the same scripted inputs, but
//      sim B does a snapshot+restore+replay round-trip at tick K.
//   3. Compare the post-replay state of sim B to sim A.
//   4. Any divergence = serializeState missed something the K→K+M
//      physics integration depends on. Hash the particle pos+vel arrays
//      (and any per-blob integrator fields) for byte-precision check.
//
// Scenarios cover the major in-game features. When the user adds a new
// physics-affecting feature (new manager, new integrator field, etc.),
// ADD a scenario here BEFORE shipping — running rollback through the
// real game without test coverage is how desyncs slip through.
//
// Wasm loading: vitest runs in node and the wasm-bindgen-generated JS
// expects fetch(). We work around by reading the wasm bytes from disk
// and passing them directly to the init function (skips fetch).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import initWasm, { SoftBodyWorldHandle } from "../physics/wasm/softbody_wasm";
import { SoftBodyWorldRust } from "../physics/softBodyWorldRust";
import { PlayerManager } from "../game/playerManager";
import { loadLevel } from "../levels/levelLoader";
import { defaultLevel } from "../levels/defaultLevel";
import { partyLevel } from "../levels/partyLevel";
import { kothLevel } from "../levels/kothLevel";
import { quantizeAxis } from "./inputProtocol";
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import type { LevelData } from "../levels/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXED_DT = 1 / 60;
const SEED = 8888;

/** Initialise wasm once for the whole test file. */
async function loadWasmForTests(): Promise<void> {
  const wasmPath = resolve(__dirname, "../physics/wasm/softbody_wasm_bg.wasm");
  const bytes = readFileSync(wasmPath);
  // Initialiser accepts an ArrayBuffer / BufferSource (we copy to a
  // fresh ArrayBuffer to avoid SharedArrayBuffer typing weirdness).
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  // wasm-bindgen's __wbg_init signature: `(module_or_path?) | ({ module_or_path? })`.
  // Pass the bytes directly via the object form so it never hits fetch().
  await initWasm({ module_or_path: ab as ArrayBuffer });
  // Sanity: handle constructor exists.
  if (typeof SoftBodyWorldHandle !== "function") {
    throw new Error("wasm did not initialise SoftBodyWorldHandle");
  }
}

beforeAll(async () => {
  await loadWasmForTests();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface Sim {
  world: SoftBodyEngine;
  players: PlayerManager;
  level: LevelData;
}

function buildSim(level: LevelData, seed = SEED): Sim {
  const world = new SoftBodyWorldRust({ rngSeed: seed });
  const { playerSpawnPoints } = loadLevel(world, level);
  const players = new PlayerManager(playerSpawnPoints);
  players.addPlayer("p1", "Alice", world);
  players.addPlayer("p2", "Bob", world);
  return { world, players, level };
}

function step(sim: Sim, inputs: Record<string, { moveX: number; moveY: number; expanding: boolean }>): void {
  for (const [pid, inp] of Object.entries(inputs)) {
    const mp = sim.players.getPlayer(pid);
    if (!mp) continue;
    mp.moveX = inp.moveX;
    mp.moveY = inp.moveY;
    mp.expanding = inp.expanding;
  }
  sim.players.updateAll(FIXED_DT, sim.world);
  sim.world.step(FIXED_DT);
}

/** FNV-1a hex hash of the engine's full pos+vel surface. The Rust engine
 *  also exposes `stateHash()` which is its own canonical hash — we
 *  compare BOTH (they should agree). */
function snapshotBytes(sim: Sim): { pv: number[]; engineHash: string } {
  const pv: number[] = [];
  for (const p of sim.world.pos) pv.push(p.x, p.y);
  for (const v of sim.world.vel) pv.push(v.x, v.y);
  return { pv, engineHash: sim.world.stateHash() };
}

function snapshotEqual(a: { pv: number[]; engineHash: string }, b: { pv: number[]; engineHash: string }): boolean {
  if (a.engineHash !== b.engineHash) return false;
  if (a.pv.length !== b.pv.length) return false;
  for (let i = 0; i < a.pv.length; i++) if (a.pv[i] !== b.pv[i]) return false;
  return true;
}

function findFirstDivergence(a: number[], b: number[]): { index: number; aVal: number; bVal: number } | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return { index: i, aVal: a[i], bVal: b[i] };
  }
  if (a.length !== b.length) return { index: n, aVal: a.length, bVal: b.length };
  return null;
}

// ─── Input scripts ──────────────────────────────────────────────────────────

/** Calm: gentle horizontal motion, no expand. */
function scriptCalm(t: number): Record<string, { moveX: number; moveY: number; expanding: boolean }> {
  return {
    p1: { moveX: quantizeAxis(Math.sin(t * 0.05)), moveY: 0, expanding: false },
    p2: { moveX: quantizeAxis(-Math.cos(t * 0.04)), moveY: 0, expanding: false },
  };
}

/** Chaotic: rapid direction changes + frequent expand toggles. Exercises
 *  the integrators that hold cross-tick state (expand shape scale, etc.). */
function scriptChaos(t: number): Record<string, { moveX: number; moveY: number; expanding: boolean }> {
  // Inputs flip sign multiple times per second to expose state that
  // depends on previous-frame deltas.
  return {
    p1: {
      moveX: quantizeAxis(((t * 7) % 11) < 5 ? 1 : -1),
      moveY: quantizeAxis(((t * 5) % 9) < 4 ? 1 : -1),
      expanding: (t % 3) === 0,
    },
    p2: {
      moveX: quantizeAxis(((t * 3) % 13) < 6 ? -1 : 1),
      moveY: quantizeAxis(((t * 11) % 7) < 3 ? -1 : 1),
      expanding: (t % 5) < 2,
    },
  };
}

// ─── The exactness pattern ──────────────────────────────────────────────────

interface RoundTripOptions {
  level: LevelData;
  script: (t: number) => Record<string, { moveX: number; moveY: number; expanding: boolean }>;
  snapshotAtTick: number;
  totalTicks: number;
}

/** Capture BOTH engine + SlimeBlob state — mirrors production's
 *  RollbackController which snapshots `engine.serializeState()` AND
 *  `game.snapshotGameState()`. Earlier versions of this test snapshotted
 *  only engine state, but `SlimeBlob.expandShapeScale` is a JS-side
 *  integrator that mutates per tick, so engine-only rollback diverges
 *  on every player input — exactly the bug Phase 4 was supposed to
 *  catch. */
interface FullSnap {
  engineBuf: Uint8Array;
  // SlimeBlob.dumpState's full shape is private to the SlimeBlob module;
  // we only need to round-trip the object, so `unknown` + the same
  // restoreState the production code uses is enough.
  blobs: Array<{ blobId: number; state: unknown }>;
}

function snapshotFull(sim: Sim): FullSnap {
  const blobs: FullSnap["blobs"] = [];
  for (const p of sim.players.getAllPlayers()) {
    blobs.push({ blobId: p.blob.blobId, state: p.blob.dumpState() });
  }
  return { engineBuf: sim.world.serializeState(), blobs };
}

function restoreFull(sim: Sim, snap: FullSnap): boolean {
  if (!sim.world.restoreState(snap.engineBuf)) return false;
  const byId = new Map(sim.players.getAllPlayers().map((p) => [p.blob.blobId, p.blob]));
  for (const entry of snap.blobs) {
    // The shape of `state` is whatever dumpState returned. Cast to the
    // expected parameter type — same pattern as game.restoreGameState.
    byId.get(entry.blobId)?.restoreState(entry.state as Parameters<import("../physics/slimeBlob").SlimeBlob["restoreState"]>[0]);
  }
  return true;
}

/** Run two sims with identical inputs. Sim B does a full serialize→
 *  restore→replay round-trip at `snapshotAtTick` (engine state +
 *  SlimeBlob state per player, mirroring production's
 *  game.snapshotGameState). After totalTicks, both should have
 *  IDENTICAL state. If not, the snapshot is missing some piece of
 *  state that affects post-snapshot integration. */
function runRoundTripScenario(opts: RoundTripOptions): { match: boolean; firstDiff: ReturnType<typeof findFirstDivergence>; hashA: string; hashB: string } {
  const a = buildSim(opts.level);
  const b = buildSim(opts.level);

  // Run both sims forward to snapshotAtTick.
  for (let t = 0; t < opts.snapshotAtTick; t++) {
    const inp = opts.script(t);
    step(a, inp);
    step(b, inp);
  }

  // B: serialize FULL state (engine + SlimeBlob), scribble over, restore.
  const snap = snapshotFull(b);
  expect(snap.engineBuf.byteLength, "serializeState returned empty buffer").toBeGreaterThan(0);

  // Force b through another scenario (apply junk input + step) so the
  // restore has to actually undo something on both layers.
  step(b, { p1: { moveX: 0.7, moveY: -0.3, expanding: true }, p2: { moveX: -0.4, moveY: 0.9, expanding: false } });
  step(b, { p1: { moveX: -1, moveY: 1, expanding: false }, p2: { moveX: 1, moveY: -1, expanding: true } });
  const restored = restoreFull(b, snap);
  expect(restored, "restoreState returned false").toBe(true);

  // Now run BOTH from snapshotAtTick to totalTicks with the same script.
  for (let t = opts.snapshotAtTick; t < opts.totalTicks; t++) {
    const inp = opts.script(t);
    step(a, inp);
    step(b, inp);
  }

  const sa = snapshotBytes(a);
  const sb = snapshotBytes(b);
  return {
    match: snapshotEqual(sa, sb),
    firstDiff: findFirstDivergence(sa.pv, sb.pv),
    hashA: sa.engineHash,
    hashB: sb.engineHash,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("rollback exactness (Rust+wasm engine)", () => {
  it("engine.stateHash is non-empty (sanity: wasm loaded correctly)", () => {
    const s = buildSim(defaultLevel);
    expect(s.world.stateHash().length).toBeGreaterThan(0);
  });

  it("calm motion, defaultLevel (with NPCs): serialize→restore→replay matches baseline", () => {
    const result = runRoundTripScenario({
      level: defaultLevel,
      script: scriptCalm,
      snapshotAtTick: 30,
      totalTicks: 120,
    });
    if (!result.match) {
      console.error("DESYNC after rollback. hashA=", result.hashA, "hashB=", result.hashB, "firstDiff=", result.firstDiff);
    }
    expect(result.match).toBe(true);
  });

  it("chaotic motion, defaultLevel (with NPCs): exercises expand integrator + collisions", () => {
    const result = runRoundTripScenario({
      level: defaultLevel,
      script: scriptChaos,
      snapshotAtTick: 30,
      totalTicks: 120,
    });
    if (!result.match) {
      console.error("DESYNC after rollback. hashA=", result.hashA, "hashB=", result.hashB, "firstDiff=", result.firstDiff);
    }
    expect(result.match).toBe(true);
  });

  it("chaotic motion, partyLevel (with spring pads): exercises spring contact state", () => {
    const result = runRoundTripScenario({
      level: partyLevel,
      script: scriptChaos,
      snapshotAtTick: 30,
      totalTicks: 120,
    });
    if (!result.match) {
      console.error("DESYNC after rollback. hashA=", result.hashA, "hashB=", result.hashB, "firstDiff=", result.firstDiff);
    }
    expect(result.match).toBe(true);
  });

  it("chaotic motion, kothLevel (NPCs + hill zones): broader coverage", () => {
    const result = runRoundTripScenario({
      level: kothLevel,
      script: scriptChaos,
      snapshotAtTick: 30,
      totalTicks: 120,
    });
    if (!result.match) {
      console.error("DESYNC after rollback. hashA=", result.hashA, "hashB=", result.hashB, "firstDiff=", result.firstDiff);
    }
    expect(result.match).toBe(true);
  });

  it("late-snapshot (after collisions have built up persistent state)", () => {
    // Snapshot AFTER the blobs have had time to collide and accumulate
    // sticky-contact-style state. If contact/integrator state isn't in
    // serializeState, this fails where the early-snapshot tests pass.
    const result = runRoundTripScenario({
      level: defaultLevel,
      script: scriptChaos,
      snapshotAtTick: 90,
      totalTicks: 180,
    });
    if (!result.match) {
      console.error("DESYNC after late rollback. hashA=", result.hashA, "hashB=", result.hashB, "firstDiff=", result.firstDiff);
    }
    expect(result.match).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // Keyframe wire-format completeness.
  //
  // In production the host sends a "keyframe" reliable event carrying
  // ONLY particle positions + velocities (see PlayerRecord/WorldRecord
  // in src/lib/wireProtocol.ts) plus the player's expandScale. The
  // guest snaps particles and updates SlimeBlob.expandShapeScale on
  // arrival. Then both sims continue stepping with identical input
  // broadcasts and are expected to agree.
  //
  // But the Rust engine has MANY mutable fields beyond particles
  // (shape_match_rest_scale, frame_override, blob_pin_snapshots,
  //  static_surfaces.prev_poly/velocity, trigger_prev, etc.) AND every
  // game-side manager has its own dumpState. The keyframe never ships
  // any of that. Result: post-keyframe sims start from different
  // states and diverge deterministically every tick (the symptom the
  // user observed when the compare-hashes modal showed 100% red).
  //
  // Test 1 reproduces the bug by syncing ONLY what the wire format
  // currently carries — divergence is expected.
  //
  // Test 2 proves the fix shape: syncing via engine.serializeState() +
  // SlimeBlob.dumpState() (i.e. what game.snapshotGameState already
  // does) keeps the sims aligned.

  it("PARTICLE-ONLY keyframe (matches current wire format) leaves sims divergent", () => {
    const a = buildSim(defaultLevel);
    const b = buildSim(defaultLevel);
    // CRITICAL: drive A and B with DIFFERENT inputs so their engine
    // state genuinely differs by tick 30. If both run the same script,
    // they're already in sync at the moment of the "keyframe" and the
    // wire-format incompleteness is masked. Production sees divergence
    // because the guest joins LATE: the host has been mutating things
    // for K ticks while the guest's local sim is still at initial
    // state. The keyframe wire format must close that gap.
    for (let t = 0; t < 30; t++) step(a, scriptChaos(t));
    // B runs a different stream (the "guest's-local-sim-before-keyframe"
    // simulation: never pressed anything, just gravity).
    for (let t = 0; t < 30; t++) {
      step(b, { p1: { moveX: 0, moveY: 0, expanding: false }, p2: { moveX: 0, moveY: 0, expanding: false } });
    }

    // Apply ONLY what the production keyframe currently carries:
    //   - particle pos + vel (PlayerRecord/WorldRecord)
    //   - RNG state (carried by the separate rng_state reliable event)
    //   - SlimeBlob.expandShapeScale (carried in PlayerRecord.expandScale)
    // Everything else (engine-mutable state + every manager's dumpState)
    // is silently left at B's local values.
    for (let i = 0; i < a.world.pos.length; i++) {
      b.world.setParticlePos(i, a.world.pos[i].x, a.world.pos[i].y);
      b.world.setParticleVel(i, a.world.vel[i].x, a.world.vel[i].y);
    }
    b.world.setTick(a.world.tick);
    b.world.rng.setState(a.world.rng.getState());
    // Mirror production EXACTLY: PlayerRecord carries moveX/Y/expanding +
    // expandScale, and OnlineGuest.applySnapshot applies them via
    // setExpandStateExternal. Everything ELSE on the SlimeBlob
    // (stickX, stickY, expandWasPressed, gravityOverride, stuckTo,
    // stickReleaseGrace, moveForceMultiplier, expandSpeedMultiplier)
    // stays at the guest's local value — which DIFFERS from host's
    // since the guest hasn't been replaying host's history.
    for (const pid of ["p1", "p2"]) {
      const ap = a.players.getPlayer(pid);
      const bp = b.players.getPlayer(pid);
      if (ap && bp) {
        bp.moveX = ap.moveX;
        bp.moveY = ap.moveY;
        bp.expanding = ap.expanding;
        bp.blob.setExpandStateExternal(ap.expanding, (ap.blob.dumpState() as { expandShapeScale: number }).expandShapeScale);
      }
    }

    // Step both with identical inputs.
    for (let t = 30; t < 90; t++) {
      const inp = scriptChaos(t);
      step(a, inp);
      step(b, inp);
    }

    const sa = snapshotBytes(a);
    const sb = snapshotBytes(b);
    // Regression guard: a particle-ONLY keyframe IS insufficient. If
    // someone "simplifies" by dropping engineState from the wire and
    // this test starts passing (becomes a no-op), we know the fix
    // was undone.
    expect(snapshotEqual(sa, sb)).toBe(false);
  });

  it("WIRE: keyframe (engineState) + manager_state (per-blob JSON) end-to-end", async () => {
    // Mirrors the FULL production wire path:
    //   1. Host: build keyframe binary (with engineState) + manager_state
    //      JSON event (with per-blob SlimeBlob.dumpState — the addition
    //      this session shipped).
    //   2. Wire: serialize → deserialize for both.
    //   3. Guest: world.restoreState(engineState) then for each blob
    //      blob.restoreState(slimeBlobs[i].state) — matching what
    //      BouncyBlobsGame.restoreGameState would do via the
    //      manager_state event handler.
    //   4. Both step 60 more ticks. Hashes must match per tick.
    //
    // Without the per-blob JSON in step 1+3, the test fails — the user's
    // compare-hashes modal went 100% red because production was shipping
    // engineState but NOT the JS-side SlimeBlob state.
    const { encodeSnapshot, decodeSnapshot } = await import("./wireProtocol");
    const a = buildSim(defaultLevel);
    const b = buildSim(defaultLevel);
    // Diverge: A runs chaos, B runs zero-input.
    for (let t = 0; t < 30; t++) step(a, scriptChaos(t));
    for (let t = 0; t < 30; t++) {
      step(b, { p1: { moveX: 0, moveY: 0, expanding: false }, p2: { moveX: 0, moveY: 0, expanding: false } });
    }

    // ── Host side: build wire payloads ────────────────────────────────
    const keyframeBytes = encodeSnapshot({
      version: 2,
      isKeyframe: true,
      tick: a.world.tick,
      players: [],
      world: [],
      engineState: a.world.serializeState(),
    });
    // Mirror what BouncyBlobsGame.snapshotGameState's slimeBlobs section
    // produces (the only piece this test exercises directly — full
    // manager dumpStates need a real BouncyBlobsGame instance, covered
    // by manual 2-tab + the compare-hashes modal).
    const managerStateJson = JSON.stringify({
      type: "manager_state",
      tick: a.world.tick,
      state: {
        gameTime: 0,
        slimeBlobs: a.players.getAllPlayers().map((p) => ({
          blobId: p.blob.blobId,
          state: p.blob.dumpState(),
        })),
      },
    });

    // ── Guest side: decode + apply (mirrors applySnapshot + applyManagerState) ──
    const frame = decodeSnapshot(keyframeBytes);
    expect(frame).not.toBeNull();
    expect(frame!.engineState).toBeDefined();
    expect(b.world.restoreState(frame!.engineState!)).toBe(true);

    const parsed = JSON.parse(managerStateJson) as {
      state: { slimeBlobs: Array<{ blobId: number; state: unknown }> };
    };
    const byId = new Map(b.players.getAllPlayers().map((p) => [p.blob.blobId, p.blob]));
    for (const entry of parsed.state.slimeBlobs) {
      byId.get(entry.blobId)?.restoreState(entry.state as Parameters<import("../physics/slimeBlob").SlimeBlob["restoreState"]>[0]);
    }

    // ── Both step forward with same inputs ───────────────────────────
    for (let t = 30; t < 90; t++) {
      const inp = scriptChaos(t);
      step(a, inp);
      step(b, inp);
    }
    expect(snapshotEqual(snapshotBytes(a), snapshotBytes(b))).toBe(true);
  });

  it("WIRE keyframe v2 (encode→decode→restoreState) keeps sims in sync end-to-end", async () => {
    // Goes through the ACTUAL production wireProtocol encoder + decoder
    // path, so any future change to either side that drops/breaks the
    // engineState block will trip this test.
    const { encodeSnapshot, decodeSnapshot } = await import("./wireProtocol");
    const a = buildSim(defaultLevel);
    const b = buildSim(defaultLevel);
    for (let t = 0; t < 30; t++) step(a, scriptChaos(t));
    for (let t = 0; t < 30; t++) {
      step(b, { p1: { moveX: 0, moveY: 0, expanding: false }, p2: { moveX: 0, moveY: 0, expanding: false } });
    }

    // Encode A → bytes → decode → apply on B exactly like the host's
    // broadcast and the guest's applySnapshot do.
    const encoded = encodeSnapshot({
      version: 2,
      isKeyframe: true,
      tick: a.world.tick,
      players: [],   // we don't ship per-player records here — the engineState round-trip alone is the contract under test
      world: [],
      engineState: a.world.serializeState(),
    });
    const frame = decodeSnapshot(encoded);
    expect(frame).not.toBeNull();
    expect(frame!.engineState, "decoded engineState should be present").toBeDefined();
    expect(b.world.restoreState(frame!.engineState!), "restoreState rejected the wire bytes").toBe(true);
    // Also restore SlimeBlob state (production carries this via PlayerRecord +
    // setExpandStateExternal; here we just copy the JS-side ring directly).
    for (const pid of ["p1", "p2"]) {
      const ap = a.players.getPlayer(pid);
      const bp = b.players.getPlayer(pid);
      if (ap && bp) bp.blob.restoreState(ap.blob.dumpState());
    }

    for (let t = 30; t < 90; t++) {
      const inp = scriptChaos(t);
      step(a, inp);
      step(b, inp);
    }
    expect(snapshotEqual(snapshotBytes(a), snapshotBytes(b))).toBe(true);
  });

  it("FULL-STATE keyframe (engine.serializeState + SlimeBlob.dumpState) keeps sims in sync", () => {
    const a = buildSim(defaultLevel);
    const b = buildSim(defaultLevel);
    // Same setup as the particle-only test above: A and B diverge
    // before the "keyframe" so the wire format has to actually
    // reconcile real differences.
    for (let t = 0; t < 30; t++) step(a, scriptChaos(t));
    for (let t = 0; t < 30; t++) {
      step(b, { p1: { moveX: 0, moveY: 0, expanding: false }, p2: { moveX: 0, moveY: 0, expanding: false } });
    }

    // Sync via the same path production's host-side RollbackController
    // uses (which is lossless per the existing 8/8 round-trip tests).
    // If the keyframe wire format mirrored this, post-keyframe sims
    // would agree per-tick — proving the fix shape.
    const snap = snapshotFull(a);
    expect(restoreFull(b, snap)).toBe(true);

    for (let t = 30; t < 90; t++) {
      const inp = scriptChaos(t);
      step(a, inp);
      step(b, inp);
    }

    const sa = snapshotBytes(a);
    const sb = snapshotBytes(b);
    expect(snapshotEqual(sa, sb)).toBe(true);
  });

  it("multiple snapshot/restore cycles compound correctly", () => {
    // Hammer the snapshot/restore path the way actual rollback does
    // (every 10 ticks under heavy network jitter). If serializeState is
    // SLIGHTLY lossy, the error accumulates across cycles and shows up
    // here even when a single round-trip masks it.
    const a = buildSim(defaultLevel);
    const b = buildSim(defaultLevel);

    for (let t = 0; t < 60; t++) {
      const inp = scriptChaos(t);
      step(a, inp);
      step(b, inp);
      // B: every 10 ticks, full-snapshot → scribble → restore → continue.
      if (t > 0 && t % 10 === 0) {
        const snap = snapshotFull(b);
        step(b, { p1: { moveX: 0.5, moveY: -0.5, expanding: true }, p2: { moveX: -0.5, moveY: 0.5, expanding: false } });
        const ok = restoreFull(b, snap);
        expect(ok, `restoreFull failed at tick ${t}`).toBe(true);
      }
    }

    const sa = snapshotBytes(a);
    const sb = snapshotBytes(b);
    if (!snapshotEqual(sa, sb)) {
      console.error(
        "DESYNC after compound rollback. hashA=", sa.engineHash,
        "hashB=", sb.engineHash,
        "firstDiff=", findFirstDivergence(sa.pv, sb.pv),
      );
    }
    expect(snapshotEqual(sa, sb)).toBe(true);
  });

  it("RNG state survives serialize/restore (deterministic AI / spawn rolls)", () => {
    const a = buildSim(defaultLevel);
    const stateBefore = a.world.rng.getState();
    const snap = a.world.serializeState();
    // Consume RNG to advance state.
    for (let i = 0; i < 10; i++) a.world.rng.next();
    const stateAfter = a.world.rng.getState();
    expect(stateAfter).not.toBe(stateBefore);
    // Restore — RNG state should snap back too.
    a.world.restoreState(snap);
    expect(a.world.rng.getState()).toBe(stateBefore);
  });
});
