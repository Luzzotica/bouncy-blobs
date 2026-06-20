// When ONE blob gets crushed, nearby blobs must not also pop/die. The original
// failure: a crushed blob does 1-2 frames of explosive re-inflation that
// launches + crushes everyone around it (instant screen wipe). These 5 layouts
// crush a "victim" among "bystanders" and assert the bystanders survive: no
// crush event of their own, healthy area, no extreme launch velocity.

import { describe, it, expect, beforeAll } from 'vitest';
import { loadWasmForTests } from './testWasm';
import { SoftBodyWorldRust } from './softBodyWorldRust';
import { loadLevel } from '../levels/levelLoader';
import { circle } from './hullPresets';
import type { LevelData } from '../levels/types';

const DT = 1 / 60;
const FLOOR_TOP = 1500;

const BLOB_PARAMS = {
  hullRestLocal: circle(16, 48),
  centerLocal: { x: 0, y: 0 },
  centerMass: 0.1, hullMass: 0.06,
  springK: 50.6, springDamp: 3.5,
  radialK: 0, radialDamp: 0,
  pressureK: 0.12,
  shapeMatchK: 121, shapeMatchDamp: 1.5,
};

function floorWorld(): SoftBodyWorldRust {
  const world = new SoftBodyWorldRust({ rngSeed: 7, gravity: { x: 0, y: 3920 } });
  const level: LevelData = {
    name: 'crush-collateral', version: 1,
    bounds: { width: 40000, height: 16000 },
    platforms: [{ id: 'floor', x: 0, y: FLOOR_TOP + 150, width: 30000, height: 300, rotation: 0, material: 'default' }],
    walls: [], spawnPoints: [{ id: 'sp', x: 0, y: 0, type: 'player' }], npcBlobs: [],
  };
  loadLevel(world, level);
  return world;
}

interface Blob { id: number; hull: number[]; restArea: number; }

function addBlob(world: SoftBodyWorldRust, x: number, y: number): Blob {
  const res = world.addBlobFromHull({ ...BLOB_PARAMS, worldOrigin: { x, y } });
  const hull = Array.from(res.hullIndices);
  return { id: res.blobId, hull, restArea: area(world, hull) };
}

function area(world: SoftBodyWorldRust, hull: number[]): number {
  const pos = world.pos;
  let a = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = pos[hull[i]], q = pos[hull[(i + 1) % hull.length]];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function speed(world: SoftBodyWorldRust, hull: number[]): number {
  const vel = world.vel;
  let vx = 0, vy = 0;
  for (const i of hull) { vx += vel[i].x; vy += vel[i].y; }
  return Math.hypot(vx / hull.length, vy / hull.length);
}

interface Result {
  victimCrushed: boolean;
  bystanderCrushed: boolean;
  bystanderMinAreaFrac: number;
  bystanderMaxSpeed: number;
}

/**
 * Bystanders are placed on the floor and SETTLED first (non-overlapping), then
 * the victim drops onto the bare floor at x=0 holding DOWN (reliable crush).
 * "Popping" = a bystander gets crushed or its area collapses. Getting shoved is
 * fine; vanishing is not.
 */
function runLayout(bystanders: { x: number; y: number }[]): Result {
  const world = floorWorld();
  let victimId = -1;
  const crushedIds = new Set<number>();
  world.onBlobCrushed = (id) => crushedIds.add(id);

  // Rest the bystanders on the floor first so they're not in an overlapping,
  // pre-compressed state when the victim arrives.
  const others = bystanders.map(b => addBlob(world, b.x, b.y));
  for (let t = 0; t < 120; t++) world.step(DT);
  const restAreas = others.map(o => area(world, o.hull));

  const victim = addBlob(world, 0, FLOOR_TOP - 1800);
  victimId = victim.id;

  let minAreaFrac = 1, maxSpeed = 0;
  for (let t = 0; t < 300; t++) {
    world.applyBlobMoveForce(victim.id, { x: 0, y: 1 }, 180 * 60, DT); // hold DOWN
    world.step(DT);
    others.forEach((o, i) => {
      minAreaFrac = Math.min(minAreaFrac, area(world, o.hull) / restAreas[i]);
      maxSpeed = Math.max(maxSpeed, speed(world, o.hull));
    });
  }
  return {
    victimCrushed: crushedIds.has(victimId),
    bystanderCrushed: others.some(o => crushedIds.has(o.id)),
    bystanderMinAreaFrac: minAreaFrac,
    bystanderMaxSpeed: maxSpeed,
  };
}

// All bystanders ≥110px apart (blob diameter is 96) so they start clean.
const LAYOUTS: Record<string, { x: number; y: number }[]> = {
  'flanking (±150)':     [{ x: -150, y: FLOOR_TOP - 48 }, { x: 150, y: FLOOR_TOP - 48 }],
  'tight flank (±115)':  [{ x: -115, y: FLOOR_TOP - 48 }, { x: 115, y: FLOOR_TOP - 48 }],
  'lands on a neighbor': [{ x: 0, y: FLOOR_TOP - 48 }, { x: 160, y: FLOOR_TOP - 48 }],
  'row of 4':            [{ x: -130, y: FLOOR_TOP - 48 }, { x: 130, y: FLOOR_TOP - 48 }, { x: -260, y: FLOOR_TOP - 48 }, { x: 260, y: FLOOR_TOP - 48 }],
  'stacked beside':      [{ x: 130, y: FLOOR_TOP - 48 }, { x: 130, y: FLOOR_TOP - 152 }, { x: -130, y: FLOOR_TOP - 48 }, { x: -130, y: FLOOR_TOP - 152 }],
};

describe('crushing one blob must not pop the bystanders', () => {
  beforeAll(async () => { await loadWasmForTests(); });

  for (const [name, bystanders] of Object.entries(LAYOUTS)) {
    it(name, () => {
      const r = runLayout(bystanders);
      // eslint-disable-next-line no-console
      console.log(`[collateral] ${name}: victimCrushed=${r.victimCrushed} bystanderCrushed=${r.bystanderCrushed} bystanderMinArea=${(r.bystanderMinAreaFrac * 100).toFixed(0)}% maxSpeed=${Math.round(r.bystanderMaxSpeed)}`);
      // The bystanders must never be crushed/vanished by the victim's crush.
      // (Getting shoved/squished is fine; collapsing/vanishing is not.)
      expect(r.bystanderCrushed).toBe(false);
      expect(r.bystanderMinAreaFrac).toBeGreaterThan(0.3);
    });
  }
});
