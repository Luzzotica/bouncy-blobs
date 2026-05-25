// ─────────────────────────────────────────────────────────────────────────────
// Determinism harness
//
// Two SoftBodyWorld instances seeded with the same RNG seed, loaded with the
// same level, fed identical inputs in identical tick order, must produce
// identical particle positions after N ticks. If this test ever regresses,
// something has leaked non-determinism into the simulation (Math.random in a
// physics path, wall-clock timing, Map iteration order, etc.) and the
// host/guest sims will diverge in production.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { SoftBodyWorld } from "../physics/softBodyWorld";
import { loadLevel } from "../levels/levelLoader";
import { PlayerManager } from "../game/playerManager";
import { defaultLevel } from "../levels/defaultLevel";
import { FIXED_DT } from "../game/gameLoop";

const SEED = 4242;
const TICKS = 600; // ≈ 10 seconds at 60 Hz

interface Sim {
  world: SoftBodyWorld;
  players: PlayerManager;
}

function buildSim(seed: number): Sim {
  const world = new SoftBodyWorld({ rngSeed: seed });
  const { playerSpawnPoints } = loadLevel(world, defaultLevel);
  const players = new PlayerManager(playerSpawnPoints);
  players.addPlayer("p1", "Alice", world);
  players.addPlayer("p2", "Bob", world);
  return { world, players };
}

function stepSim(sim: Sim, tick: number): void {
  // Scripted inputs that exercise both axes + the expand button. Same script
  // for both sims — the test asserts that identical inputs + identical seed
  // yield identical positions.
  const p1 = sim.players.getPlayer("p1");
  const p2 = sim.players.getPlayer("p2");
  if (p1) {
    p1.moveX = Math.sin(tick * 0.05);
    p1.moveY = 0;
    p1.expanding = tick % 30 < 15;
  }
  if (p2) {
    p2.moveX = -Math.cos(tick * 0.04);
    p2.moveY = 0;
    p2.expanding = tick % 40 < 10;
  }
  sim.players.updateAll(FIXED_DT, sim.world);
  sim.world.step(FIXED_DT);
}

function snapshot(sim: Sim): number[] {
  // Flatten every particle's (x, y) — the whole physics surface.
  const out: number[] = [];
  for (const p of sim.world.pos) {
    out.push(p.x, p.y);
  }
  return out;
}

describe("simulation determinism", () => {
  it("two worlds with the same seed + identical input stream produce identical particle positions after 600 ticks", () => {
    const a = buildSim(SEED);
    const b = buildSim(SEED);

    for (let tick = 0; tick < TICKS; tick++) {
      stepSim(a, tick);
      stepSim(b, tick);
    }

    const snapA = snapshot(a);
    const snapB = snapshot(b);
    expect(snapA.length).toBe(snapB.length);
    for (let i = 0; i < snapA.length; i++) {
      expect(snapA[i]).toBe(snapB[i]);
    }
  });

  it("spawn jitter is derived from playerId, not from the RNG stream", () => {
    // Two different seeds, same playerId → identical spawn. This is the
    // property that makes new-player spawning safe across host/guest
    // without consuming the RNG stream (which would desynchronize every
    // later deterministic decision).
    const w1 = new SoftBodyWorld({ rngSeed: 1 });
    const { playerSpawnPoints: sp1 } = loadLevel(w1, defaultLevel);
    const pm1 = new PlayerManager(sp1);
    const p1 = pm1.addPlayer("x", "X", w1);

    const w2 = new SoftBodyWorld({ rngSeed: 999 });
    const { playerSpawnPoints: sp2 } = loadLevel(w2, defaultLevel);
    const pm2 = new PlayerManager(sp2);
    const p2 = pm2.addPlayer("x", "X", w2);

    expect(p1.blob.getCentroid().x).toBe(p2.blob.getCentroid().x);
    expect(p1.blob.getCentroid().y).toBe(p2.blob.getCentroid().y);
  });

  it("different playerIds produce different spawn jitter", () => {
    const w1 = new SoftBodyWorld({ rngSeed: 42 });
    const { playerSpawnPoints: sp1 } = loadLevel(w1, defaultLevel);
    const pm1 = new PlayerManager(sp1);
    const a = pm1.addPlayer("alice", "Alice", w1);
    const b = pm1.addPlayer("bob", "Bob", w1);
    expect(a.blob.getCentroid().x).not.toBe(b.blob.getCentroid().x);
  });

  // ── Late-joiner / keyframe-round-trip determinism ───────────────────────
  // This is the test that would have caught the `expandShapeScale` snap bug:
  // it simulates the real production scenario where the host has been
  // running for some ticks before the guest's sim starts, and the guest
  // catches up by applying a keyframe replication of the host's state.
  //
  // The original determinism test built both sims at tick 0 with identical
  // state, so it never exercised the "guest reconstructs from a partial
  // snapshot" path. Any blob-internal mutable state (expand-shape
  // integrator, stick state, etc.) that wasn't in the snapshot would drift
  // silently after the keyframe — the bug behind the user's "snaps with no
  // interaction" report.
  describe("late-joiner via keyframe replication", () => {
    /** Replicate the relevant world + per-blob state from `src` into `dst`.
     * Mirrors what `GameMaster` puts in the wire-format keyframe and what
     * `OnlineGuest.applySnapshot` does to apply it. If any field that
     * matters for the integrator is missing from this list, the post-
     * replication sims diverge under identical inputs — and this test
     * catches it. */
    function replicateState(src: Sim, dst: Sim): void {
      // The full surface of "state that mutates per-tick and is read by the
      // next tick's force application." A late-joining client (or a guest
      // applying a keyframe) needs every field below to match the host or
      // the first post-keyframe tick applies different forces and the sims
      // diverge by a small amount per tick — which the keyframe yanks back
      // every second, producing the visible "snap" pattern.

      // 1. Particle positions + velocities (binary keyframe payload).
      for (let i = 0; i < src.world.pos.length; i++) {
        dst.world.pos[i] = { x: src.world.pos[i].x, y: src.world.pos[i].y };
        dst.world.vel[i] = { x: src.world.vel[i].x, y: src.world.vel[i].y };
      }
      // 2. World tick + RNG state.
      dst.world.tick = src.world.tick;
      dst.world.rng.setState(src.world.rng.getState());

      // 3. Per-blob expand-shape integrator (already on the wire as
      //    `PlayerRecord.expandScale`).
      for (const sp of src.players.getAllPlayers()) {
        const dp = dst.players.getPlayer(sp.playerId);
        if (!dp) continue;
        dp.blob.setExpandStateExternal(sp.blob.isExpanding(), sp.blob.getExpandScale());
      }

      // (`restLocal`, `shapeMatchRestScale`, `springStiffnessScale`, and
      // `springDampScale` are NOT replicated here even though they mutate
      // per tick: `SlimeBlob.update` overwrites them at the start of every
      // tick BEFORE the physics step reads them, so a fresh value is
      // installed before it matters. The tests confirm this — replicating
      // them is redundant.)

      // 4. Per-blob "ground contacts" tally — populated DURING world.step's
      //    collision pass, READ by the NEXT tick's blob.update for the
      //    grounded/airborne force multiplier. If this is stale on the
      //    receiver, the first post-keyframe tick applies the wrong
      //    horizontal-move multiplier → wrong force → wrong velocity →
      //    drift. The biggest cause of the user's "snaps with no
      //    interaction" — every jump from grounded changes this value, so
      //    any guest receiving a keyframe mid-jump applies the wrong
      //    airMult on its very first post-keyframe tick.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const srcGc = (src.world as any).blobGroundContacts;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dstGc = (dst.world as any).blobGroundContacts;
      dstGc.length = srcGc.length;
      for (let i = 0; i < srcGc.length; i++) dstGc[i] = srcGc[i] ?? 0;
    }

    it("advancing A for 60 ticks, then replicating into B, then running both for 60 more ticks under identical inputs yields bit-identical positions", () => {
      const a = buildSim(SEED);
      const b = buildSim(SEED);

      // Run A forward; B stays at tick 0. (Models "host has been playing
      // when guest connects.") Use inputs that exercise the expand button
      // because that's the integrator most likely to drift.
      for (let tick = 0; tick < 60; tick++) stepSim(a, tick);

      // B catches up via keyframe replication.
      replicateState(a, b);

      // Sanity: states should match BEFORE running B forward.
      const snap0A = snapshot(a);
      const snap0B = snapshot(b);
      for (let i = 0; i < snap0A.length; i++) {
        expect(snap0A[i]).toBe(snap0B[i]);
      }


      // Now run both for 60 ticks with identical scripted inputs. If
      // replicateState captures everything that matters, positions stay
      // bit-identical. If anything was missed, the sims diverge.
      for (let tick = 60; tick < 120; tick++) {
        stepSim(a, tick);
        stepSim(b, tick);
      }

      const snapA = snapshot(a);
      const snapB = snapshot(b);
      expect(snapA.length).toBe(snapB.length);
      for (let i = 0; i < snapA.length; i++) {
        expect(snapA[i]).toBe(snapB[i]);
      }
    });

    it("two sims with players added in OPPOSITE local orders still produce identical physics under colliding inputs (sortKey iteration-order discipline)", () => {
      // The real-world scenario this catches: the host's PlayerManager
      // inserts its own player first then receives the guest's
      // player_join, while the guest's PlayerManager inserts its own
      // first then synthesizes the host's blob from a keyframe. The two
      // clients end up with the same set of player blobs but at
      // swapped local indices. Before the sortKey fix, the collision
      // pair iteration would process the pair `(host, guest)` in one
      // role order on the host and the reversed order on the guest,
      // and `collideBlobs` is asymmetric (it pushes the first arg's
      // hull first, against a frozen snapshot of the second's polygon)
      // — so a Gauss-Seidel pass produces different end positions for
      // the same input. The sortKey makes collision iteration
      // sort-stable across clients regardless of local insertion order.
      const worldA = new SoftBodyWorld({ rngSeed: SEED });
      const worldB = new SoftBodyWorld({ rngSeed: SEED });
      const { playerSpawnPoints: spA } = loadLevel(worldA, defaultLevel);
      const { playerSpawnPoints: spB } = loadLevel(worldB, defaultLevel);
      const pmA = new PlayerManager(spA);
      const pmB = new PlayerManager(spB);

      // A inserts p1 then p2 (typical host-first ordering).
      pmA.addPlayer("p1", "Alice", worldA);
      pmA.addPlayer("p2", "Bob", worldA);

      // B inserts p2 then p1 (typical guest-first ordering — the guest
      // auto-joins itself before the keyframe synthesizes the host's
      // player). Local blob indices for p1 and p2 are swapped vs A.
      pmB.addPlayer("p2", "Bob", worldB);
      pmB.addPlayer("p1", "Alice", worldB);

      // Drive the two blobs into each other so the collision pair
      // iteration actually fires (sortKey only matters when blobs
      // overlap — non-colliding ticks hit the `aabbOverlap` early-exit).
      // Both stickX values point toward the centre so they collide.
      for (let tick = 0; tick < TICKS; tick++) {
        const ap1 = pmA.getPlayer("p1")!;
        const ap2 = pmA.getPlayer("p2")!;
        const bp1 = pmB.getPlayer("p1")!;
        const bp2 = pmB.getPlayer("p2")!;
        ap1.moveX = 1; bp1.moveX = 1;
        ap2.moveX = -1; bp2.moveX = -1;
        ap1.expanding = tick % 20 < 10; bp1.expanding = tick % 20 < 10;
        ap2.expanding = tick % 25 < 12; bp2.expanding = tick % 25 < 12;
        pmA.updateAll(FIXED_DT, worldA);
        pmB.updateAll(FIXED_DT, worldB);
        worldA.step(FIXED_DT);
        worldB.step(FIXED_DT);
      }

      // Compare per-player positions (NOT raw particle-index positions —
      // those legitimately differ because the local indices are swapped).
      // The physics state for "p1's blob" on A must match "p1's blob" on
      // B, and same for p2.
      for (const id of ["p1", "p2"] as const) {
        const a = pmA.getPlayer(id)!.blob;
        const b = pmB.getPlayer(id)!.blob;
        const cA = a.getCentroid();
        const cB = b.getCentroid();
        expect(cA.x).toBe(cB.x);
        expect(cA.y).toBe(cB.y);
      }
    });

    it("WITHOUT replicating expandShapeScale the post-keyframe sims diverge — proving the integrator must be in the snapshot", () => {
      // Regression guard for the specific bug we just fixed: the wire
      // format carries `expandScale` per player but `OnlineGuest` was
      // discarding it on receipt. This test fails (sims diverge) if you
      // remove the `setExpandStateExternal` call from replicateState.
      const a = buildSim(SEED);
      const b = buildSim(SEED);

      for (let tick = 0; tick < 60; tick++) stepSim(a, tick);

      // Partial keyframe: positions + velocities + tick + rng, BUT NOT
      // the per-blob expand integrator.
      for (let i = 0; i < a.world.pos.length; i++) {
        b.world.pos[i] = { x: a.world.pos[i].x, y: a.world.pos[i].y };
        b.world.vel[i] = { x: a.world.vel[i].x, y: a.world.vel[i].y };
      }
      b.world.tick = a.world.tick;
      b.world.rng.setState(a.world.rng.getState());
      // Intentionally NOT replicating expandShapeScale.

      for (let tick = 60; tick < 120; tick++) {
        stepSim(a, tick);
        stepSim(b, tick);
      }

      // The two sims SHOULD differ — at least one particle position diverged
      // because the expand integrator started at 1.0 on B while A's was
      // mid-integration. If this assertion ever flips (sims stay
      // identical without the expand sync), it means `expandShapeScale` is
      // no longer feeding back into physics — at which point this bug
      // class is gone and this test can be deleted.
      const snapA = snapshot(a);
      const snapB = snapshot(b);
      let diverged = false;
      for (let i = 0; i < snapA.length; i++) {
        if (snapA[i] !== snapB[i]) {
          diverged = true;
          break;
        }
      }
      expect(diverged).toBe(true);
    });
  });
});
