// ─────────────────────────────────────────────────────────────────────────────
// Replay-via-input-protocol test
//
// Exercises the late-joiner flow end-to-end at the simulation level:
//   1. A "host" SoftBodyWorld runs forward N ticks with scripted inputs,
//      encoding each tick's inputs through the binary input protocol.
//   2. A "guest" SoftBodyWorld starts at tick 0 with the same seed.
//   3. Each encoded input frame is decoded and applied to the guest, then
//      the guest steps its own sim forward one tick (mirroring what
//      `applyAggregatedInputs` does in the catch-up path of OnlineGuest).
//   4. After all N ticks, the guest's particle positions must match the
//      host's bit-for-bit.
//
// If this regresses, late joiners will end up in slightly-wrong-positions
// after their replay completes — which then breaks the live snap-on-drift
// safety net (a small post-replay error becomes a large drift over time).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { SoftBodyWorld } from "../physics/softBodyWorld";
import { loadLevel } from "../levels/levelLoader";
import { PlayerManager } from "../game/playerManager";
import { defaultLevel } from "../levels/defaultLevel";
import { FIXED_DT } from "../game/gameLoop";
import {
  encodeAggregatedInputs,
  decodeAggregatedInputs,
  quantizeAxis,
  type AggregatedTick,
} from "./inputProtocol";

const SLOT_TO_ID: Record<number, string> = { 0: "alice", 1: "bob" };
const RESOLVE = (slot: number) => SLOT_TO_ID[slot];

interface Sim {
  world: SoftBodyWorld;
  players: PlayerManager;
}

const SEED = 13371337;
const REPLAY_TICKS = 200;

function buildSim(seed: number): Sim {
  const world = new SoftBodyWorld({ rngSeed: seed });
  const { playerSpawnPoints } = loadLevel(world, defaultLevel);
  const players = new PlayerManager(playerSpawnPoints);
  players.addPlayer("alice", "Alice", world);
  players.addPlayer("bob", "Bob", world);
  return { world, players };
}

/** Scripted input — same recipe used by the determinism harness, so two
 * sims fed this in the same order should produce the same world state. */
// Pre-quantize so both host and guest apply the bit-exact canonical value
// — same as the production preTickHook flow on the host.
function inputAtTick(tick: number): AggregatedTick {
  return {
    tick,
    inputs: [
      {
        slot: 0,
        playerId: "alice",
        moveX: quantizeAxis(Math.sin(tick * 0.05)),
        moveY: 0,
        expanding: tick % 30 < 15,
      },
      {
        slot: 1,
        playerId: "bob",
        moveX: quantizeAxis(-Math.cos(tick * 0.04)),
        moveY: 0,
        expanding: tick % 40 < 10,
      },
    ],
  };
}

function applyTickInputs(sim: Sim, tick: AggregatedTick): void {
  for (const inp of tick.inputs) {
    if (!inp.playerId) continue;
    const mp = sim.players.getPlayer(inp.playerId);
    if (!mp) continue;
    mp.moveX = inp.moveX;
    mp.moveY = inp.moveY;
    mp.expanding = inp.expanding;
  }
}

function stepSim(sim: Sim): void {
  sim.players.updateAll(FIXED_DT, sim.world);
  sim.world.step(FIXED_DT);
}

function snapshot(sim: Sim): number[] {
  const out: number[] = [];
  for (const p of sim.world.pos) out.push(p.x, p.y);
  for (const v of sim.world.vel) out.push(v.x, v.y);
  return out;
}

describe("late-joiner replay", () => {
  it("guest reaches the host's state after replaying the input history through the binary protocol", () => {
    const host = buildSim(SEED);
    const recorded: ArrayBuffer[] = [];

    for (let t = 0; t < REPLAY_TICKS; t++) {
      const tickInputs = inputAtTick(t);
      applyTickInputs(host, tickInputs);
      // Encode the way the host's broadcast loop encodes — one tick per
      // packet — so we exercise the same wire format the replay bundle uses.
      recorded.push(encodeAggregatedInputs({ ticks: [tickInputs] }));
      stepSim(host);
    }

    const guest = buildSim(SEED);
    for (const buf of recorded) {
      const agg = decodeAggregatedInputs(buf, RESOLVE);
      expect(agg).not.toBeNull();
      if (!agg) return;
      for (const t of agg.ticks) {
        applyTickInputs(guest, t);
      }
      stepSim(guest);
    }

    const hostState = snapshot(host);
    const guestState = snapshot(guest);
    expect(guestState.length).toBe(hostState.length);
    for (let i = 0; i < hostState.length; i++) {
      expect(guestState[i]).toBe(hostState[i]);
    }
  });

  it("batched replay (one packet covering many ticks) matches per-tick replay", () => {
    const host = buildSim(SEED);
    const batch: AggregatedTick[] = [];
    for (let t = 0; t < REPLAY_TICKS; t++) {
      const tickInputs = inputAtTick(t);
      applyTickInputs(host, tickInputs);
      batch.push(tickInputs);
      stepSim(host);
    }
    // Single packet with all N ticks — the shape the host sends in the
    // late-joiner bundle.
    const bundle = encodeAggregatedInputs({ ticks: batch });
    const decoded = decodeAggregatedInputs(bundle, RESOLVE);
    expect(decoded).not.toBeNull();
    if (!decoded) return;

    const guest = buildSim(SEED);
    for (const t of decoded.ticks) {
      applyTickInputs(guest, t);
      stepSim(guest);
    }

    const hostState = snapshot(host);
    const guestState = snapshot(guest);
    for (let i = 0; i < hostState.length; i++) {
      expect(guestState[i]).toBe(hostState[i]);
    }
  });

  it("rng state save/restore lets two worlds diverge then re-align", () => {
    const a = new SoftBodyWorld({ rngSeed: 9001 });
    const b = new SoftBodyWorld({ rngSeed: 9001 });

    // Diverge: a consumes 100 random values, b stays put.
    for (let i = 0; i < 100; i++) a.rng.next();
    expect(a.rng.next()).not.toBe(b.rng.next());

    // Re-align via state copy — what the `rng_state` reliable event does.
    b.rng.setState(a.rng.getState());
    for (let i = 0; i < 50; i++) {
      expect(a.rng.next()).toBe(b.rng.next());
    }
  });
});
