import { describe, it, expect } from 'vitest';
import { SoftBodyWorld } from './softBodyWorld';
import { SlimeBlob, BLOB_RADIUS } from './slimeBlob';
import { vec2, Vec2 } from './vec2';
import { isPointInPolygon } from './collision';

const DT = 1 / 60;
const SIM_SECONDS = 0.6;

function makeWorld(): SoftBodyWorld {
  return new SoftBodyWorld({ gravity: vec2(0, 0) });
}

function overlapCount(polyA: Vec2[], polyB: Vec2[]): number {
  let n = 0;
  for (const p of polyA) if (isPointInPolygon(p, polyB)) n++;
  for (const p of polyB) if (isPointInPolygon(p, polyA)) n++;
  return n;
}

function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function blobMeanVelocity(world: SoftBodyWorld, blob: SlimeBlob): Vec2 {
  const vel = world.getVelocities();
  let sx = 0, sy = 0;
  for (const idx of blob.hullIndices) { sx += vel[idx].x; sy += vel[idx].y; }
  const n = blob.hullIndices.length;
  return vec2(sx / n, sy / n);
}

interface SimResult {
  maxOverlap: number;
  finalOverlap: number;
  finalCentroidDistance: number;
  finalBxVel: number;
}

function simulateHeadOn(speed: number): SimResult {
  const world = makeWorld();
  const a = new SlimeBlob(world, vec2(0, 0), { playerControlled: false });
  const b = new SlimeBlob(world, vec2(BLOB_RADIUS * 4, 0), { playerControlled: false });
  world.applyBlobLinearVelocityDelta(a.blobId, vec2(speed, 0));
  const n = Math.round(SIM_SECONDS / DT);
  let maxOverlap = 0;
  for (let i = 0; i < n; i++) {
    world.step(DT);
    const o = overlapCount(a.getHullPolygon(), b.getHullPolygon());
    if (o > maxOverlap) maxOverlap = o;
  }
  return {
    maxOverlap,
    finalOverlap: overlapCount(a.getHullPolygon(), b.getHullPolygon()),
    finalCentroidDistance: distance(a.getCentroid(), b.getCentroid()),
    finalBxVel: blobMeanVelocity(world, b).x,
  };
}

describe('blob-vs-blob CCD', () => {
  it('slow collision: blobs end up separated and B was pushed', () => {
    const r = simulateHeadOn(500);
    expect(r.finalOverlap, 'no residual overlap').toBe(0);
    expect(r.finalCentroidDistance).toBeGreaterThan(BLOB_RADIUS);
    expect(r.finalBxVel, 'target blob picks up +X velocity').toBeGreaterThan(50);
  });

  it('fast collision: blobs do not centroid-merge and B was pushed', () => {
    // 3000 px/s is where the discrete resolver historically picked the wrong
    // edge under deep penetration and the centroids ended up coincident.
    const r = simulateHeadOn(3000);
    expect(r.finalOverlap, 'no residual hull overlap').toBe(0);
    // Bug symptom: centroids stack at the same point (~0.3 px apart).
    expect(
      r.finalCentroidDistance,
      'blobs should not be centroid-merged after a fast collision',
    ).toBeGreaterThan(5);
    // The fast incoming blob must transfer momentum, not absorb it.
    expect(
      r.finalBxVel,
      'target blob should be pushed forward by a fast collision',
    ).toBeGreaterThan(500);
  });

  it('very fast collision: still resolves, momentum transferred', () => {
    const r = simulateHeadOn(5000);
    expect(r.finalOverlap).toBe(0);
    expect(r.finalCentroidDistance).toBeGreaterThan(5);
    expect(r.finalBxVel).toBeGreaterThan(800);
  });
});
