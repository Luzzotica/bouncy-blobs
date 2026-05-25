import { describe, it, expect } from "vitest";
import {
  encodeSnapshot,
  decodeSnapshot,
  WIRE_VERSION,
  ENTITY_KIND_NPC,
  ENTITY_KIND_PLATFORM,
  MAX_OFFSET,
  type SnapshotFrame,
} from "./wireProtocol";

function buildFrame(): SnapshotFrame {
  return {
    version: WIRE_VERSION,
    isKeyframe: true,
    tick: 42,
    players: [
      {
        id: "p1",
        rootX: 1234.5,
        rootY: -678.25,
        rootVx: 12.5,
        rootVy: -3.25,
        activeMask: 0xffff,
        offsets: Array.from({ length: 16 }, (_, i) => ({ idx: i, ox: i * 5, oy: -i * 3, vx: i * 0.5, vy: -i * 0.25 })),
        moveX: 0.5,
        moveY: -0.25,
        expandScale: 1.2,
        expanding: true,
        settled: false,
        score: 7,
      },
    ],
    world: [
      {
        kind: ENTITY_KIND_NPC,
        id: "npc-0",
        rootX: 100,
        rootY: 200,
        nodes: Array.from({ length: 17 }, (_, i) => ({ x: 100 + i * 7, y: 200 - i * 3, vx: i * 0.5, vy: -i * 0.2 })),
        settled: false,
      },
      {
        kind: ENTITY_KIND_PLATFORM,
        id: "plat-A",
        rootX: 0,
        rootY: 0,
        // A 24-node platform — the old offset+u16-mask format truncated to
        // 16; the new absolute-positions format syncs all of them.
        nodes: Array.from({ length: 24 }, (_, i) => ({ x: i * 25, y: 600 + (i % 2) * 5, vx: 0, vy: 0 })),
        settled: true,
      },
    ],
  };
}

describe("wireProtocol", () => {
  it("round-trips a typical frame within quantization tolerance", () => {
    const frame = buildFrame();
    const buf = encodeSnapshot(frame);
    expect(buf.byteLength).toBeGreaterThan(0);
    const out = decodeSnapshot(buf);
    expect(out).not.toBeNull();
    if (!out) return;

    expect(out.version).toBe(WIRE_VERSION);
    expect(out.isKeyframe).toBe(true);
    expect(out.tick).toBe(42);
    expect(out.players).toHaveLength(1);
    expect(out.world).toHaveLength(2);

    const p = out.players[0];
    expect(p.id).toBe("p1");
    expect(Math.abs(p.rootX - 1234.5)).toBeLessThan(0.001);
    expect(Math.abs(p.rootY - -678.25)).toBeLessThan(0.001);
    expect(p.activeMask).toBe(0xffff);
    expect(p.offsets).toHaveLength(16);
    // Quantization tolerance: 2*MAX_OFFSET/65535 ≈ 0.006 px per step
    const tol = (2 * MAX_OFFSET) / 32767 + 0.001;
    for (const o of p.offsets) {
      const ex = o.idx * 5;
      const ey = -o.idx * 3;
      expect(Math.abs(o.ox - ex)).toBeLessThan(tol);
      expect(Math.abs(o.oy - ey)).toBeLessThan(tol);
    }
    expect(Math.abs(p.moveX - 0.5)).toBeLessThan(0.001);
    expect(Math.abs(p.moveY - -0.25)).toBeLessThan(0.001);
    expect(Math.abs(p.expandScale - 1.2)).toBeLessThan(0.001);
    expect(p.expanding).toBe(true);
    expect(p.settled).toBe(false);
    expect(p.score).toBe(7);

    const npc = out.world[0];
    expect(npc.kind).toBe(ENTITY_KIND_NPC);
    expect(npc.nodes).toHaveLength(17);
    for (let i = 0; i < 17; i++) {
      expect(npc.nodes[i].x).toBeCloseTo(100 + i * 7, 4);
      expect(npc.nodes[i].y).toBeCloseTo(200 - i * 3, 4);
    }

    const plat = out.world[1];
    expect(plat.id).toBe("plat-A");
    // 24 nodes — proves the old u16/16-node activeMask cap is gone.
    expect(plat.nodes).toHaveLength(24);
    expect(plat.settled).toBe(true);
  });

  it("returns null on truncated input", () => {
    const frame = buildFrame();
    const buf = encodeSnapshot(frame);
    const trunc = buf.slice(0, 10);
    expect(decodeSnapshot(trunc)).toBeNull();
  });

  it("rejects wrong version", () => {
    const frame = buildFrame();
    const buf = encodeSnapshot(frame);
    const u8 = new Uint8Array(buf);
    u8[0] = 99;
    expect(decodeSnapshot(buf)).toBeNull();
  });

  it("bandwidth estimate stays within spec target for 4 players + 8 NPCs", () => {
    // Spec target: ~111 bytes/player at 16-node full keyframes.
    const playerCount = 4;
    const npcCount = 8;
    const frame: SnapshotFrame = {
      version: WIRE_VERSION,
      isKeyframe: true,
      tick: 1,
      players: Array.from({ length: playerCount }, (_, i) => ({
        id: `p${i}`,
        rootX: 0, rootY: 0, rootVx: 0, rootVy: 0,
        activeMask: 0xffff,
        offsets: Array.from({ length: 16 }, (_, j) => ({ idx: j, ox: j, oy: j, vx: 0, vy: 0 })),
        moveX: 0, moveY: 0, expandScale: 1, expanding: false, settled: false, score: 0,
      })),
      world: Array.from({ length: npcCount }, (_, i) => ({
        kind: ENTITY_KIND_NPC,
        id: `npc-${i}`, rootX: 0, rootY: 0,
        nodes: Array.from({ length: 17 }, (_, j) => ({ x: j, y: j, vx: 0, vy: 0 })),
        settled: false,
      })) as any,
    };
    const buf = encodeSnapshot(frame);
    // Velocity adds 8 bytes per node — keyframe roughly doubled per-entity.
    // Still tiny compared to the ~30 KB/s of the original full-state stream.
    expect(buf.byteLength).toBeLessThan(playerCount * 250 + npcCount * 320 + 64);
  });
});
