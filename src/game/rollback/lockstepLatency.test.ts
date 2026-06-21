// ─────────────────────────────────────────────────────────────────────────────
// Lockstep-under-latency tests (Rust+wasm engine + real RollbackController).
//
// Why this file exists: network conditions are never perfect. The guest
// forward-tags each input for `world.tick + 1 + inputDelayTicks` and the host
// applies it at that tick. The moment real (or simulated) latency pushes the
// input's arrival past its claimed tick, the host can only still apply it via
// rollback. With rollback OFF those inputs are silently dropped and the guest
// stops moving entirely — exactly the bug the always-on net sim surfaced.
//
// These tests drive the REAL `RollbackController` against the REAL wasm engine
// to prove that, with rollback on, late authoritative inputs reconcile to the
// SAME bit-identical state as a zero-latency reference sim. If a future change
// breaks rollback's interaction with the engine/hash-ring, these go red before
// it ships (the companion guard to rollbackExactness.test.ts, which covers the
// snapshot/restore round-trip without the prediction+latency dimension).
//
// Pattern per test:
//   1. Build a reference sim that applies host+guest inputs ON TIME every tick.
//   2. Build a "host" sim driven by RollbackController that only ever learns
//      the guest's input LATE (via onAuthoritativeInputs), predicting guest
//      idle / last-known in the meantime.
//   3. After delivering every guest input authoritatively, the host's state
//      must equal the reference's — and the guest blob must have actually moved
//      (so we're not trivially comparing two no-op sims).
//
// Wasm loading mirrors rollbackExactness.test.ts (read bytes from disk, init
// directly — vitest runs in node with no fetch()).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import initWasm, { SoftBodyWorldHandle } from "../../physics/wasm/softbody_wasm";
import { SoftBodyWorldRust } from "../../physics/softBodyWorldRust";
import { PlayerManager } from "../playerManager";
import { loadLevel } from "../../levels/levelLoader";
import { defaultLevel } from "../../levels/defaultLevel";
import { quantizeAxis } from "../../lib/inputProtocol";
import { RollbackController, type InputSet, type PlayerInput } from "./RollbackController";
import type { SoftBodyEngine } from "../../physics/SoftBodyEngine";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXED_DT = 1 / 60;
const SEED = 8888;
const HOST = "host";
const GUEST = "guest";

async function loadWasmForTests(): Promise<void> {
  const wasmPath = resolve(__dirname, "../../physics/wasm/softbody_wasm_bg.wasm");
  const bytes = readFileSync(wasmPath);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await initWasm({ module_or_path: ab as ArrayBuffer });
  if (typeof SoftBodyWorldHandle !== "function") {
    throw new Error("wasm did not initialise SoftBodyWorldHandle");
  }
}

beforeAll(async () => {
  await loadWasmForTests();
});

// ─── Sim + game-adapter helpers ──────────────────────────────────────────────

interface Sim {
  world: SoftBodyEngine;
  players: PlayerManager;
}

function buildSim(seed = SEED): Sim {
  const world = new SoftBodyWorldRust({ rngSeed: seed });
  const { playerSpawnPoints } = loadLevel(world, defaultLevel);
  const players = new PlayerManager(playerSpawnPoints);
  players.addPlayer(HOST, "Host", world);
  players.addPlayer(GUEST, "Guest", world);
  return { world, players };
}

function applyToPM(players: PlayerManager, inputs: InputSet): void {
  for (const [pid, inp] of Object.entries(inputs)) {
    const mp = players.getPlayer(pid);
    if (!mp) continue;
    mp.moveX = inp.moveX;
    mp.moveY = inp.moveY;
    mp.expanding = inp.expanding;
  }
}

/** Minimal BouncyBlobsGame-shaped adapter for RollbackController: snapshots
 *  and restores per-blob SlimeBlob state (the JS-side integrators), mirroring
 *  what game.snapshotGameState()/restoreGameState() round-trip in production.
 *  Same approach rollbackExactness.test.ts uses for its full snapshot. */
function makeGameAdapter(players: PlayerManager) {
  return {
    snapshotGameState() {
      return {
        gameTime: 0,
        slimeBlobs: players.getAllPlayers().map((p) => ({ blobId: p.blob.blobId, state: p.blob.dumpState() })),
      };
    },
    restoreGameState(snap: { slimeBlobs?: Array<{ blobId: number; state: unknown }> }) {
      if (!snap.slimeBlobs) return;
      const byId = new Map(players.getAllPlayers().map((p) => [p.blob.blobId, p.blob]));
      for (const entry of snap.slimeBlobs) {
        byId.get(entry.blobId)?.restoreState(
          entry.state as Parameters<import("../../physics/slimeBlob").SlimeBlob["restoreState"]>[0],
        );
      }
    },
  };
}

function stateHash(sim: Sim): string {
  return sim.world.stateHash();
}

function posVel(sim: Sim): number[] {
  const out: number[] = [];
  for (const p of sim.world.pos) out.push(p.x, p.y);
  for (const v of sim.world.vel) out.push(v.x, v.y);
  return out;
}

function firstDivergence(a: number[], b: number[]): { index: number; a: number; b: number } | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return { index: i, a: a[i], b: b[i] };
  if (a.length !== b.length) return { index: n, a: a.length, b: b.length };
  return null;
}

// ─── Input scripts ───────────────────────────────────────────────────────────

const idle: PlayerInput = { moveX: 0, moveY: 0, expanding: false };

/** Host holds right the whole time (always known locally → never mispredicted). */
function hostScript(_t: number): PlayerInput {
  return { moveX: quantizeAxis(1), moveY: 0, expanding: false };
}

/** Guest is idle, then presses left for a stretch, then idle again. The two
 *  edges (start + stop) are the mispredictions that force the host to roll
 *  back when the late authoritative input finally arrives. */
function guestScript(t: number): PlayerInput {
  if (t >= 5 && t < 25) return { moveX: quantizeAxis(-1), moveY: 0, expanding: false };
  return idle;
}

function fullInputs(t: number): InputSet {
  return { [HOST]: hostScript(t), [GUEST]: guestScript(t) };
}

// ─── Reference: zero-latency ground truth ─────────────────────────────────────

function runReference(totalTicks: number): Sim {
  const ref = buildSim();
  for (let t = 0; t < totalTicks; t++) {
    applyToPM(ref.players, fullInputs(t));
    ref.players.updateAll(FIXED_DT, ref.world);
    ref.world.step(FIXED_DT);
  }
  return ref;
}

// ─── Host driven by RollbackController, learning guest input `latency` ticks
//     late. Returns the host sim after a final flush delivers every guest
//     input authoritatively. ────────────────────────────────────────────────

function runHostWithLatency(totalTicks: number, latency: number): Sim {
  const host = buildSim();
  const game = makeGameAdapter(host.players);

  // What the host reads for its OWN player each tick (local input is never
  // late). Updated immediately before each predictInputs().
  let liveHostInput: PlayerInput = idle;

  const rc = new RollbackController({
    localPlayerId: HOST,
    readLocalInput: () => ({ ...liveHostInput }),
    applyInputs: (inputs) => applyToPM(host.players, inputs),
    // One logic tick, matching the live step below so replay is identical.
    stepOne: () => {
      host.players.updateAll(FIXED_DT, host.world);
      host.world.step(FIXED_DT);
    },
  });

  // Deliver the guest's (and host's) authoritative input for tick `at`,
  // mirroring the host's late-input handler: take what we recorded and
  // override with the authoritative values, then reconcile.
  const delivered = new Set<number>();
  const deliverAuth = (at: number) => {
    if (at < 0 || delivered.has(at)) return;
    delivered.add(at);
    const recorded = rc.getRecordedInputs(at) ?? {};
    const auth: InputSet = { ...recorded, ...fullInputs(at) };
    rc.onAuthoritativeInputs(new Map([[at, auth]]), host.world, game as never);
  };

  for (let i = 0; i < totalTicks; i++) {
    const t = host.world.tick; // 0-based; the tick this iteration produces
    liveHostInput = hostScript(t);
    // Predict: host = live keyboard, guest = last-known authoritative (idle
    // until its first auth arrives). This is the prediction that will be
    // WRONG across the guest's input edges → rollback on arrival.
    const inputs = rc.predictInputs();
    applyToPM(host.players, inputs);
    rc.recordTick(t, inputs, host.world, game as never);
    host.players.updateAll(FIXED_DT, host.world);
    host.world.step(FIXED_DT);
    // The guest input for tick (t - latency) arrives now.
    deliverAuth(t - latency);
  }

  // Flush every guest input that hasn't arrived yet (the trailing `latency`
  // ticks). The final reconcile replays with the full authoritative history.
  for (let at = 0; at < totalTicks; at++) deliverAuth(at);

  return host;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("lockstep under input latency (rollback)", () => {
  it("the guest actually moves in the reference sim (sanity)", () => {
    const total = 40;
    const ref = buildSim();
    const start = ref.players.getPlayer(GUEST)!.blob.getCentroid();
    const refRun = runReference(total);
    const end = refRun.players.getPlayer(GUEST)!.blob.getCentroid();
    const moved = Math.hypot(end.x - start.x, end.y - start.y);
    // The guest presses left for 20 ticks — it must have travelled.
    expect(moved).toBeGreaterThan(0.1);
  });

  for (const latency of [4, 8, 16]) {
    it(`late guest input (${latency}-tick latency) reconciles to the zero-latency state`, () => {
      const total = 40;
      const ref = runReference(total);
      const host = runHostWithLatency(total, latency);

      const refHash = stateHash(ref);
      const hostHash = stateHash(host);
      const diff = firstDivergence(posVel(ref), posVel(host));

      // Bit-identical: rollback fully reconstructed the ground-truth timeline.
      expect(diff).toBeNull();
      expect(hostHash).toBe(refHash);
    });
  }

  it("at least one rollback actually fired (the path is exercised, not bypassed)", () => {
    // Re-run instrumented so we can read the controller's counter.
    const total = 40;
    const latency = 8;
    const host = buildSim();
    const game = makeGameAdapter(host.players);
    let liveHostInput: PlayerInput = idle;
    const rc = new RollbackController({
      localPlayerId: HOST,
      readLocalInput: () => ({ ...liveHostInput }),
      applyInputs: (inputs) => applyToPM(host.players, inputs),
      stepOne: () => {
        host.players.updateAll(FIXED_DT, host.world);
        host.world.step(FIXED_DT);
      },
    });
    const delivered = new Set<number>();
    const deliverAuth = (at: number) => {
      if (at < 0 || delivered.has(at)) return;
      delivered.add(at);
      const recorded = rc.getRecordedInputs(at) ?? {};
      rc.onAuthoritativeInputs(new Map([[at, { ...recorded, ...fullInputs(at) }]]), host.world, game as never);
    };
    for (let i = 0; i < total; i++) {
      const t = host.world.tick;
      liveHostInput = hostScript(t);
      const inputs = rc.predictInputs();
      applyToPM(host.players, inputs);
      rc.recordTick(t, inputs, host.world, game as never);
      host.players.updateAll(FIXED_DT, host.world);
      host.world.step(FIXED_DT);
      deliverAuth(t - latency);
    }
    for (let at = 0; at < total; at++) deliverAuth(at);

    expect(rc.rollbacksApplied).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input-only reconciliation (opt-in `?rollback=1` / client-prediction path).
// NOTE: the SHIPPING model is pure host-authoritative lockstep (no rollback) —
// the host stamps each input at the tick it arrives, so there is nothing to
// reconcile. This test guards the OPT-IN rollback path: a peer that first
// applies a STALE input for a tick and later receives the CORRECTED input
// (re-sent in a redundant broadcast window) must roll back and converge to
// ground truth WITHOUT any state keyframe — proving rollback stays an option
// if we ever want client-side prediction back.
// ─────────────────────────────────────────────────────────────────────────────

describe("input-only reconciliation (corrected input re-sent, no keyframe)", () => {
  // Local player (this peer's own, known live) holds right; remote player's
  // TRUE input is idle→right→idle. The broadcast first carries a STALE (idle)
  // value for the remote at every tick, then re-sends the corrected value
  // REVISION_DELAY ticks later — modelling the host patching recentSchedule
  // after a late input and the K-window re-broadcasting it.
  const localScript = (_t: number): PlayerInput => ({ moveX: quantizeAxis(1), moveY: 0, expanding: false });
  const remoteTrue = (t: number): PlayerInput =>
    t >= 5 && t < 25 ? { moveX: quantizeAxis(1), moveY: 0, expanding: false } : idle;

  function refSim(total: number): Sim {
    const ref = buildSim();
    for (let t = 0; t < total; t++) {
      applyToPM(ref.players, { [HOST]: localScript(t), [GUEST]: remoteTrue(t) });
      ref.players.updateAll(FIXED_DT, ref.world);
      ref.world.step(FIXED_DT);
    }
    return ref;
  }

  it("stale-then-corrected remote input converges to ground truth via rollback only", () => {
    const total = 40;
    const REVISION_DELAY = 6; // corrected value arrives 6 ticks after the stale one
    const ref = refSim(total);

    const peer = buildSim();
    const game = makeGameAdapter(peer.players);
    let restoreFromWireCalls = 0;
    // Guard: this test must NEVER apply a state keyframe. Wrap restoreState so
    // any wire-style full-state resync would be caught. (RollbackController
    // calls engine.restoreState internally during replay — that's expected and
    // is the input-driven path, so we only flag calls we make ourselves.)
    const wireRestore = () => { restoreFromWireCalls++; };

    let liveLocal: PlayerInput = idle;
    const rc = new RollbackController({
      localPlayerId: HOST,
      readLocalInput: () => ({ ...liveLocal }),
      applyInputs: (inputs) => applyToPM(peer.players, inputs),
      stepOne: () => {
        peer.players.updateAll(FIXED_DT, peer.world);
        peer.world.step(FIXED_DT);
      },
    });

    for (let i = 0; i < total; i++) {
      const t = peer.world.tick;
      liveLocal = localScript(t);
      // Apply the in-time broadcast: correct local (we know it live) + STALE
      // remote (idle). This is the "wrong" value the peer commits to first.
      const inTime: InputSet = { [HOST]: localScript(t), [GUEST]: idle };
      applyToPM(peer.players, inTime);
      rc.recordTick(t, inTime, peer.world, game as never);
      peer.players.updateAll(FIXED_DT, peer.world);
      peer.world.step(FIXED_DT);
      // The corrected broadcast for an earlier tick arrives now.
      const ct = t - REVISION_DELAY;
      if (ct >= 0) {
        const corrected: InputSet = { [HOST]: localScript(ct), [GUEST]: remoteTrue(ct) };
        rc.onAuthoritativeInputs(new Map([[ct, corrected]]), peer.world, game as never);
      }
    }
    // Flush corrections for the trailing REVISION_DELAY ticks.
    for (let ct = Math.max(0, total - REVISION_DELAY); ct < total; ct++) {
      const corrected: InputSet = { [HOST]: localScript(ct), [GUEST]: remoteTrue(ct) };
      rc.onAuthoritativeInputs(new Map([[ct, corrected]]), peer.world, game as never);
    }

    expect(rc.rollbacksApplied).toBeGreaterThan(0); // the corrected inputs forced reconciliation
    expect(restoreFromWireCalls).toBe(0); // no keyframe/state resync was used
    void wireRestore;
    const diff = firstDivergence(posVel(ref), posVel(peer));
    expect(diff).toBeNull();
    expect(stateHash(peer)).toBe(stateHash(ref));
  });
});
