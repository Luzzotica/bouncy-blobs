// Repro for "hit the ground hard → blob vanishes (only the face stays), expand
// to come back". Cause: a hard landing over-compresses the soft hull; the
// pressure-crush check (`cur_area < target_area / 10`) fires, and the solver's
// "defense in depth" collapses every particle to the centroid → the hull is a
// zero-area dot (invisible) while the face still renders at the centroid. The
// zero area then re-triggers the crush every frame, so it stays gone until an
// expand inflates it back past the threshold.
//
// This drops a player blob onto a floor and checks whether a plain hard landing
// trips the crush. It should NOT.

import { describe, it, expect, beforeAll } from 'vitest';
import { loadWasmForTests } from './testWasm';
import { SoftBodyWorldRust } from './softBodyWorldRust';
import { loadLevel } from '../levels/levelLoader';
import { PlayerManager } from '../game/playerManager';
import type { LevelData } from '../levels/types';

const DT = 1 / 60;

/** Floor with the spawn point `dropHeight` px above it. */
function dropLevel(dropHeight: number): LevelData {
  const floorTop = 2600;
  return {
    name: 'crush-drop', version: 1,
    bounds: { width: 20000, height: 12000 },
    platforms: [{ id: 'floor', x: 0, y: floorTop + 150, width: 12000, height: 300, rotation: 0, material: 'default' }],
    walls: [],
    spawnPoints: [{ id: 'sp1', x: 0, y: floorTop - dropHeight, type: 'player' }],
    npcBlobs: [],
  };
}

function hullArea(world: SoftBodyWorldRust, hull: number[]): number {
  const pos = world.pos;
  let a = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = pos[hull[i]], q = pos[hull[(i + 1) % hull.length]];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Drop a blob from `dropHeight`; optionally hold DOWN. Returns the min hull
 *  area during impact AND the final area after settling (the recovery — if the
 *  blob "vanished and stuck", this stays ~0). */
function drop(dropHeight: number, pressDown = false): { minAreaFrac: number; finalAreaFrac: number } {
  const world = new SoftBodyWorldRust({ rngSeed: 7, gravity: { x: 0, y: 3920 } });
  const { playerSpawnPoints } = loadLevel(world, dropLevel(dropHeight));
  const players = new PlayerManager(playerSpawnPoints);
  const mp = players.addPlayer('p1', 'P1', world);
  const hull = Array.from(mp.blob.hullIndices);

  const restArea = hullArea(world, hull);
  let minArea = restArea;
  for (let t = 0; t < 240; t++) {
    mp.moveX = 0; mp.moveY = pressDown ? 1 : 0; mp.expanding = false;
    players.updateAll(DT, world);
    world.step(DT);
    minArea = Math.min(minArea, hullArea(world, hull));
  }
  // Let it settle without input, then read the final area (did it come back?).
  for (let t = 0; t < 120; t++) {
    mp.moveX = 0; mp.moveY = 0; mp.expanding = false;
    players.updateAll(DT, world);
    world.step(DT);
  }
  return { minAreaFrac: minArea / restArea, finalAreaFrac: hullArea(world, hull) / restArea };
}

describe('crush on hard landing (vanishing-blob repro)', () => {
  beforeAll(async () => { await loadWasmForTests(); });

  it('a hard landing (even holding DOWN) recovers — the blob never stays vanished', () => {
    for (const h of [2000, 3500, 5000, 8000]) {
      const b = drop(h, true);
      // eslint-disable-next-line no-console
      console.log(`[crush] drop ${h}px +DOWN → minArea=${(b.minAreaFrac * 100).toFixed(0)}%  finalArea=${(b.finalAreaFrac * 100).toFixed(0)}%`);
    }
    // After the worst slam, the blob must re-inflate (not stay a collapsed dot).
    for (const h of [2000, 5000]) {
      expect(drop(h, true).finalAreaFrac).toBeGreaterThan(0.7);
    }
  });
});
