// Experiment: is shape-matching (+ contact pinning) what locks floor rotation?
// Build identical blobs on the same default floor, command the same spin, and
// vary only shape_match_damp / shape_match_k. If lowering them lets the floor
// churn, the theory holds.

import { describe, it, beforeAll } from 'vitest';
import { loadWasmForTests } from './testWasm';
import { SoftBodyWorldRust } from './softBodyWorldRust';
import { loadLevel } from '../levels/levelLoader';
import { circle } from './hullPresets';
import type { LevelData } from '../levels/types';

const DT = 1 / 60;
const TREAD = 6000;

function floorLevel(): LevelData {
  return {
    name: 'stall-exp', version: 1,
    bounds: { width: 20000, height: 8000 },
    platforms: [{ id: 'floor', x: 0, y: 700, width: 12000, height: 300, rotation: 0, material: 'default' }],
    walls: [], spawnPoints: [{ id: 'sp1', x: 0, y: 300, type: 'player' }], npcBlobs: [],
  };
}

function centroid(world: SoftBodyWorldRust, hull: number[]) {
  const pos = world.pos;
  let cx = 0, cy = 0;
  for (const i of hull) { cx += pos[i].x; cy += pos[i].y; }
  return { x: cx / hull.length, y: cy / hull.length };
}

/** Build a blob with the given shape-match params, rest it, command a fixed
 *  spin, and return realized revolutions + mean contacting hull points. */
function run(shapeMatchK: number, shapeMatchDamp: number): { revs: number; touched: number } {
  const world = new SoftBodyWorldRust({ rngSeed: 7, gravity: { x: 0, y: 3920 } });
  loadLevel(world, floorLevel()); // registers the static floor
  const res = world.addBlobFromHull({
    hullRestLocal: circle(16, 48),
    centerLocal: { x: 0, y: 0 },
    centerMass: 0.1, hullMass: 0.06,
    springK: 50.6, springDamp: 3.5,
    radialK: 0, radialDamp: 0,
    pressureK: 0.12,
    shapeMatchK, shapeMatchDamp,
    worldOrigin: { x: 0, y: 300 },
  });
  const hull = Array.from(res.hullIndices);
  const marker = hull[0];

  for (let t = 0; t < 120; t++) world.step(DT); // settle onto floor

  const angle = () => {
    const c = centroid(world, hull);
    const p = world.pos[marker];
    return Math.atan2(p.y - c.y, p.x - c.x);
  };
  let prev = angle(), total = 0, touchAcc = 0;
  for (let t = 0; t < 180; t++) {
    world.setBlobTread(res.blobId, TREAD);
    world.step(DT);
    let d = angle() - prev; prev = angle();
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    const contacts = world.getBlobParticleContacts(res.blobId);
    let touched = 0;
    for (const i of hull) if (contacts[i]) touched++;
    touchAcc += touched;
  }
  return { revs: Math.abs(total) / (2 * Math.PI), touched: touchAcc / 180 };
}

describe('EXPERIMENT: does loosening shape-matching unlock floor rotation?', () => {
  beforeAll(async () => { await loadWasmForTests(); });

  it('sweeps shape_match_k and shape_match_damp', () => {
    const cases: [string, number, number][] = [
      ['baseline   K=121 D=4.6', 121, 4.6],
      ['low damp   K=121 D=1.0', 121, 1.0],
      ['no damp    K=121 D=0.0', 121, 0.0],
      ['soft spring K=40  D=4.6', 40, 4.6],
      ['soft both  K=40  D=1.0', 40, 1.0],
      ['very soft  K=15  D=0.5', 15, 0.5],
    ];
    for (const [name, k, d] of cases) {
      const r = run(k, d);
      // eslint-disable-next-line no-console
      console.log(`[stall] ${name}  →  revs=${r.revs.toFixed(2)}  contacts=${r.touched.toFixed(1)}/16`);
    }
  });
});
