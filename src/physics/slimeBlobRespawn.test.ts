import { describe, it, expect, beforeAll } from 'vitest';
import { SoftBodyWorldRust } from './softBodyWorldRust';
import { loadWasmForTests } from './testWasm';
import { vec2 } from './vec2';
import { SlimeBlob, BLOB_RADIUS } from './slimeBlob';

beforeAll(async () => { await loadWasmForTests(); });

function hullMaxRadius(world: SoftBodyWorldRust, blobId: number): { center: { x: number; y: number }; maxR: number } {
  const hull = world.getHullPolygon(blobId);
  let cx = 0, cy = 0;
  for (const p of hull) { cx += p.x; cy += p.y; }
  cx /= hull.length; cy /= hull.length;
  let maxR = 0;
  for (const p of hull) {
    const r = Math.hypot(p.x - cx, p.y - cy);
    if (r > maxR) maxR = r;
  }
  return { center: { x: cx, y: cy }, maxR };
}

describe('SlimeBlob.respawnReset — crush recovery', () => {
  it('rebuilds a clean rest pose after the hull is spread across the map', () => {
    const world = new SoftBodyWorldRust({ rngSeed: 1 });
    const blob = new SlimeBlob(world, vec2(0, 0));

    // Simulate a crush ejection: fling one hull particle far away, and balloon
    // the expand state — exactly the state that made respawns come back BIG and
    // gave the blob a map-spanning AABB.
    world.setParticlePos(blob.hullIndices[0], 100_000, 100_000);
    blob.setExpandStateExternal(true, 3.5);

    const spread = hullMaxRadius(world, blob.blobId);
    expect(spread.maxR).toBeGreaterThan(10_000); // genuinely deformed

    // Recover at a fresh spawn point.
    blob.respawnReset(vec2(500, 500));

    const after = hullMaxRadius(world, blob.blobId);
    // Hull is back to rest size (a tight circle), not spread across the map.
    expect(after.maxR).toBeLessThan(BLOB_RADIUS * 1.5);
    expect(after.maxR).toBeGreaterThan(BLOB_RADIUS * 0.5);
    // Centred on the spawn point.
    expect(after.center.x).toBeCloseTo(500, 0);
    expect(after.center.y).toBeCloseTo(500, 0);
    // Deflated — no longer "BIG mode".
    expect(blob.getExpandScale()).toBe(1.0);
  });
});
