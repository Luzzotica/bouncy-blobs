// ─────────────────────────────────────────────────────────────────────────────
// Sim-exactness tests for the tick-tagged netcode.
//
// These tests build TWO independent SoftBodyWorld + PlayerManager instances
// (representing host + guest) and feed them the same scripted inputs at the
// same logical ticks. After N steps, hash the engine state from each and
// assert byte-for-byte equality. If host and guest sims agree here, any
// real desync we see in 2-tab play is in the wire/queueing/timing layer —
// NOT in the physics. Conversely, if these tests fail, the foundation is
// broken and no amount of network plumbing will fix it.
//
// We also include explicit world.tick-semantics tests because the netcode
// depends on knowing exactly what `world.tick` means (last-completed vs.
// about-to-run) and an off-by-one there will desync everything.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { SoftBodyWorld } from "../physics/softBodyWorld";
import { loadLevel } from "../levels/levelLoader";
import { PlayerManager } from "../game/playerManager";
import { defaultLevel } from "../levels/defaultLevel";
import { FIXED_DT } from "../game/gameLoop";
import { quantizeAxis } from "./inputProtocol";

const SEED = 7777;

interface Sim {
  world: SoftBodyWorld;
  players: PlayerManager;
}

function build(): Sim {
  const world = new SoftBodyWorld({ rngSeed: SEED });
  const { playerSpawnPoints } = loadLevel(world, defaultLevel);
  const players = new PlayerManager(playerSpawnPoints);
  players.addPlayer("alice", "Alice", world);
  players.addPlayer("bob", "Bob", world);
  return { world, players };
}

/** Flatten the full physics surface (every particle's pos + vel) into a
 *  number array for byte-precise comparison. Doesn't rely on
 *  Rust-engine-only stateHash. */
function snapshot(sim: Sim): number[] {
  const out: number[] = [];
  for (const p of sim.world.pos) out.push(p.x, p.y);
  for (const v of sim.world.vel) out.push(v.x, v.y);
  return out;
}

function snapshotEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Apply pre-quantized inputs to ManagedPlayer.* and step once. */
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

/** Build a quantized input set for tick t (deterministic script). */
function script(t: number): Record<string, { moveX: number; moveY: number; expanding: boolean }> {
  return {
    alice: {
      moveX: quantizeAxis(Math.sin(t * 0.13)),
      moveY: quantizeAxis(Math.cos(t * 0.07)),
      expanding: (t % 20) < 10,
    },
    bob: {
      moveX: quantizeAxis(-Math.cos(t * 0.11)),
      moveY: quantizeAxis(Math.sin(t * 0.09)),
      expanding: (t % 30) < 15,
    },
  };
}

describe("netcode sim exactness", () => {
  it("world.tick semantics: increments AFTER world.step", () => {
    const w = new SoftBodyWorld({ rngSeed: SEED });
    loadLevel(w, defaultLevel);
    const t0 = w.tick;
    w.step(FIXED_DT);
    const t1 = w.tick;
    w.step(FIXED_DT);
    const t2 = w.tick;
    // After N steps, world.tick === N (started at 0).
    // This tells us "world.tick" === "number of completed steps" === "last
    // completed tick (0-indexed)" === "next tick to run is world.tick + 1".
    expect(t0).toBe(0);
    expect(t1).toBe(1);
    expect(t2).toBe(2);
  });

  it("two sims fed identical inputs at identical ticks produce identical state", () => {
    const a = build();
    const b = build();
    for (let t = 0; t < 300; t++) {
      const inp = script(t);
      step(a, inp);
      step(b, inp);
    }
    expect(snapshotEqual(snapshot(a), snapshot(b))).toBe(true);
  });

  it("desyncs immediately if one sim applies an input one tick later than the other", () => {
    // Regression guard: this test exists to demonstrate WHY the tick-tagged
    // netcode must apply inputs at the exact same logical tick on both
    // sides. We let sim B apply alice's input one tick LATER than sim A
    // for a single tick, then run identical inputs forever after. The
    // sims should diverge and stay diverged — proving that a 1-tick
    // input offset is unrecoverable without rollback.
    const a = build();
    const b = build();
    for (let t = 0; t < 100; t++) {
      const inp = script(t);
      step(a, inp);
      // B applies the PREVIOUS tick's alice input (one tick stale).
      const prev = t > 0 ? script(t - 1) : { alice: { moveX: 0, moveY: 0, expanding: false }, bob: inp.bob };
      step(b, { alice: prev.alice, bob: inp.bob });
    }
    expect(snapshotEqual(snapshot(a), snapshot(b))).toBe(false);
  });

  it("rollback-and-replay reproduces same state when late input is corrected", () => {
    // Simulate what hostRollbackRef does on late input:
    // 1. Run sim A normally (the "correct" trajectory).
    // 2. Run sim B with a WRONG input at tick K, then "rollback" by
    //    re-running from scratch with the corrected input.
    // 3. Both should produce the same state at the end.
    const K = 50;
    const TOTAL = 100;

    const a = build();
    for (let t = 0; t < TOTAL; t++) step(a, script(t));

    const b = build();
    // First pass: apply WRONG input at K (alice goes the wrong way).
    for (let t = 0; t < K; t++) step(b, script(t));
    const wrong = script(K);
    wrong.alice = { moveX: quantizeAxis(-1), moveY: quantizeAxis(-1), expanding: false };
    step(b, wrong);
    for (let t = K + 1; t < TOTAL; t++) step(b, script(t));
    expect(snapshotEqual(snapshot(a), snapshot(b))).toBe(false); // sanity: wrong input diverged

    // Now "rollback": rebuild B and replay with correct inputs.
    const c = build();
    for (let t = 0; t < TOTAL; t++) step(c, script(t));
    expect(snapshotEqual(snapshot(a), snapshot(c))).toBe(true); // determinism confirmed
  });

  it("axis quantization is idempotent (canonical precision boundary)", () => {
    for (const v of [-1, -0.7071068, -0.5, -0.1, 0, 0.1, 0.5, 0.7071068, 1]) {
      const q1 = quantizeAxis(v);
      const q2 = quantizeAxis(q1);
      const q3 = quantizeAxis(q2);
      expect(q1).toBe(q2);
      expect(q2).toBe(q3);
    }
  });

  it("tick-tagged queue + drain reproduces matching state when guest sim runs ahead of host's drain", () => {
    // End-to-end-ish test of the tick-tagged input pipeline:
    //   - "guest" sim immediately applies its input at tick G (writes
    //     MP, runs sim → state for G+1).
    //   - "host" sim receives the input tagged for the SAME tick the
    //     guest's step produced (G+1), queues it, drains at that tick.
    //   - After N ticks, both sims should have identical state.
    //
    // This is the foundational property that a tick-tagged netcode
    // depends on. If this passes, the queue+drain semantics are right.
    // If it fails, we have an off-by-one (e.g. host draining queue[T]
    // when it should be queue[T+1]) — exactly the bug class the world.
    // tick semantic test above guards against.

    const guestSim = build();
    const hostSim = build();
    // Per-player queue of {tick → input} on the host, simulating what
    // pendingGuestInputsRef does inside GameMaster.
    const hostQueue = new Map<string, Map<number, { moveX: number; moveY: number; expanding: boolean }>>();

    /** What the guest does each iteration: read script for current
     *  guest.world.tick, write to MP, capture applyTick = world.tick + 1
     *  (the tick the upcoming step will produce), send to host queue,
     *  then step. */
    const guestIteration = (t: number, inputs: Record<string, { moveX: number; moveY: number; expanding: boolean }>) => {
      const applyTick = guestSim.world.tick + 1;
      // Apply locally (writes MP).
      for (const [pid, inp] of Object.entries(inputs)) {
        const mp = guestSim.players.getPlayer(pid);
        if (!mp) continue;
        mp.moveX = inp.moveX; mp.moveY = inp.moveY; mp.expanding = inp.expanding;
      }
      // "Send" to host: tag with applyTick.
      for (const [pid, inp] of Object.entries(inputs)) {
        let perTick = hostQueue.get(pid);
        if (!perTick) { perTick = new Map(); hostQueue.set(pid, perTick); }
        perTick.set(applyTick, { ...inp });
      }
      // Step.
      guestSim.players.updateAll(FIXED_DT, guestSim.world);
      guestSim.world.step(FIXED_DT);
      void t;
    };

    /** What the host does each iteration: BEFORE its step, drain
     *  queue at the tick this step will produce (host.world.tick + 1),
     *  write to MP, step. This is what GameMaster's preTickHook does. */
    const hostIteration = () => {
      const T = hostSim.world.tick + 1;
      for (const [pid, perTick] of hostQueue) {
        const v = perTick.get(T);
        if (!v) continue;
        const mp = hostSim.players.getPlayer(pid);
        if (mp) {
          mp.moveX = v.moveX; mp.moveY = v.moveY; mp.expanding = v.expanding;
        }
        perTick.delete(T);
      }
      hostSim.players.updateAll(FIXED_DT, hostSim.world);
      hostSim.world.step(FIXED_DT);
    };

    // Run 300 iterations in lockstep (guest steps, then host steps with
    // the queue already filled — simulating ~zero latency).
    for (let t = 0; t < 300; t++) {
      const inp = script(t);
      guestIteration(t, inp);
      hostIteration();
    }

    expect(snapshotEqual(snapshot(guestSim), snapshot(hostSim))).toBe(true);
  });

  it("tick-tagged queue + drain reproduces matching state even when host runs AHEAD of guest input arrival", () => {
    // Like above but the host's iteration happens BEFORE the guest's
    // input "arrives" — simulating network latency where host has
    // already advanced past the guest's claimed apply tick.
    //
    // With JUST queue+drain (no rollback) this WILL desync — the late
    // input misses its slot and is dropped. The test asserts the
    // divergence so we have a regression guard documenting why
    // rollback is necessary in real netcode (full RC reconciliation
    // is exercised separately in the rollback section of replay.test.ts
    // and via the existing prediction-mode tests).
    const guestSim = build();
    const hostSim = build();
    const hostQueue = new Map<string, Map<number, { moveX: number; moveY: number; expanding: boolean }>>();

    for (let t = 0; t < 100; t++) {
      const inp = script(t);
      // Host steps FIRST (gets ahead).
      const T = hostSim.world.tick + 1;
      for (const [pid, perTick] of hostQueue) {
        const v = perTick.get(T);
        if (v) {
          const mp = hostSim.players.getPlayer(pid);
          if (mp) { mp.moveX = v.moveX; mp.moveY = v.moveY; mp.expanding = v.expanding; }
          perTick.delete(T);
        }
      }
      hostSim.players.updateAll(FIXED_DT, hostSim.world);
      hostSim.world.step(FIXED_DT);

      // Guest then runs its iteration — its applyTick for this input
      // will be guest.world.tick + 1 which is BEHIND host's tick.
      const applyTick = guestSim.world.tick + 1;
      for (const [pid, ip] of Object.entries(inp)) {
        const mp = guestSim.players.getPlayer(pid);
        if (mp) { mp.moveX = ip.moveX; mp.moveY = ip.moveY; mp.expanding = ip.expanding; }
        let perTick = hostQueue.get(pid);
        if (!perTick) { perTick = new Map(); hostQueue.set(pid, perTick); }
        perTick.set(applyTick, { ...ip });
      }
      guestSim.players.updateAll(FIXED_DT, guestSim.world);
      guestSim.world.step(FIXED_DT);
    }

    // Without rollback, the late inputs are dropped → host's sim
    // applied "no input" while guest applied the scripted input.
    // Sims diverge. THIS is exactly the case host-side rollback exists
    // to handle.
    expect(snapshotEqual(snapshot(guestSim), snapshot(hostSim))).toBe(false);
  });
});
