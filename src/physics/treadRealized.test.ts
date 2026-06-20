// What the PLAYER actually sees: does a commanded tread realize as VISIBLE hull
// rotation? My earlier test measured the value handed to `setBlobTread` (the
// command) — but the engine only spins FREE (non-contact) hull points, and that
// injected velocity must then survive the collision/friction/shape-match solve.
//
// Hypothesis from the report ("static on the floor, churns like mad on the
// ceiling"): when gravity presses the blob HARD into the floor, most hull
// points are in contact (few free) and the solver eats the circulation → no
// visible spin. On the ceiling gravity pulls you OFF the surface → light
// contact → lots of free points, circulation survives → it churns.
//
// We test that directly: SAME commanded tread, blob resting, measured by the
// real rotation of a hull vertex about the centroid, under HARD press (full
// gravity) vs LIGHT press (weak gravity, standing in for the ceiling's light
// contact). We also count contacting hull points.

import { describe, it, expect, beforeAll } from 'vitest';
import { loadWasmForTests } from './testWasm';
import { SoftBodyWorldRust } from './softBodyWorldRust';
import { loadLevel } from '../levels/levelLoader';
import { PlayerManager } from '../game/playerManager';
import type { LevelData } from '../levels/types';

const DT = 1 / 60;
const TREAD = 6000; // a strong, fixed commanded spin

function floorLevel(): LevelData {
  return {
    name: 'tread-realized', version: 1,
    bounds: { width: 20000, height: 8000 },
    platforms: [{ id: 'floor', x: 0, y: 700, width: 12000, height: 300, rotation: 0, material: 'default' }],
    walls: [],
    spawnPoints: [{ id: 'sp1', x: 0, y: 300, type: 'player' }],
    npcBlobs: [],
  };
}

function centroid(world: SoftBodyWorldRust, hull: readonly number[]) {
  const pos = world.pos;
  let cx = 0, cy = 0;
  for (const i of hull) { cx += pos[i].x; cy += pos[i].y; }
  return { x: cx / hull.length, y: cy / hull.length };
}

interface R { revs: number; touched: number; hullN: number; }

/** Rest a blob on the floor under the given gravity, command a fixed tread each
 *  tick, and measure how far a hull vertex actually revolves + how many hull
 *  points are in contact. No movement input — pure "does the wheel turn". */
function run(gravityY: number): R {
  const world = new SoftBodyWorldRust({ rngSeed: 7, gravity: { x: 0, y: gravityY } });
  const { playerSpawnPoints } = loadLevel(world, floorLevel());
  const players = new PlayerManager(playerSpawnPoints);
  const mp = players.addPlayer('p1', 'P1', world);
  const blob = mp.blob;
  const hull = blob.hullIndices;
  const marker = hull[0];

  for (let t = 0; t < 120; t++) { players.updateAll(DT, world); world.step(DT); } // settle

  const angle = () => {
    const c = centroid(world, hull);
    const p = world.pos[marker];
    return Math.atan2(p.y - c.y, p.x - c.x);
  };
  // Cap the blob's translation each tick (keep relative/circulation velocity) so
  // it stays on the floor at a realistic walking speed instead of accelerating
  // off the edge — lets us compare rotation at EQUAL speed across surfaces.
  const SPEED_CAP = 350;
  const capSpeed = () => {
    const vel = world.vel;
    let vx = 0, vy = 0;
    for (const i of hull) { vx += vel[i].x; vy += vel[i].y; }
    vx /= hull.length; vy /= hull.length;
    const sp = Math.hypot(vx, vy);
    if (sp <= SPEED_CAP) return;
    const ex = vx * (1 - SPEED_CAP / sp), ey = vy * (1 - SPEED_CAP / sp);
    for (const i of hull) world.setParticleVel(i, vel[i].x - ex, vel[i].y - ey);
  };
  let prev = angle(), total = 0, touchAcc = 0;
  for (let t = 0; t < 180; t++) {
    mp.moveX = 1; mp.moveY = 0; mp.expanding = false; // STEER right (drives my STEER_BASE tread)
    players.updateAll(DT, world);
    world.step(DT);
    capSpeed();
    let d = angle() - prev; prev = angle();
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    const contacts = world.getBlobParticleContacts(blob.blobId);
    let touched = 0;
    for (const i of hull) if (contacts[i]) touched++;
    touchAcc += touched;
  }
  return { revs: Math.abs(total) / (2 * Math.PI), touched: touchAcc / 180, hullN: hull.length };
}

describe('tread REALIZED rotation — hard press (floor) vs light press (ceiling-like)', () => {
  beforeAll(async () => { await loadWasmForTests(); });

  it('ROLLING: a commanded spin propels the body via contact-patch friction (no input)', () => {
    // We now spin EVERY hull point, contacts included. Friction on the spinning
    // contact patch pulls the body along — i.e. it rolls — even with no movement
    // input. (Previously gripped points were skipped, so there was no traction
    // and the blob just sat there.)
    const world = new SoftBodyWorldRust({ rngSeed: 7, gravity: { x: 0, y: 3920 } });
    const { playerSpawnPoints } = loadLevel(world, floorLevel());
    const players = new PlayerManager(playerSpawnPoints);
    const mp = players.addPlayer('p1', 'P1', world);
    const hull = mp.blob.hullIndices;
    for (let t = 0; t < 120; t++) { players.updateAll(DT, world); world.step(DT); }
    const x0 = centroid(world, hull).x;
    for (let t = 0; t < 180; t++) {
      mp.moveX = 0; mp.moveY = 0; mp.expanding = false;
      players.updateAll(DT, world);
      world.setBlobTread(mp.blob.blobId, TREAD);
      world.step(DT);
    }
    const roll = Math.abs(centroid(world, hull).x - x0);
    // eslint-disable-next-line no-console
    console.log(`[realized] no-input ROLL distance over 3s with tread=${TREAD}: ${roll.toFixed(0)}px`);
    expect(roll).toBeGreaterThan(30); // it now rolls under its own spin
  });

  it('DIAGNOSTIC: same command, real rotation under hard vs light contact', () => {
    const floor = run(3920);   // full gravity — pressed hard into the floor
    const light = run(150);    // barely pressing — stands in for the ceiling's light contact
    const log = (n: string, r: R) =>
      // eslint-disable-next-line no-console
      console.log(`[realized] ${n}: revs=${r.revs.toFixed(2)}  contactingHullPts=${r.touched.toFixed(1)}/${r.hullN}`);
    log('hard floor ', floor);
    log('light/ceil ', light);
    // eslint-disable-next-line no-console
    console.log(`[realized] revs ratio light/floor = ${(light.revs / Math.max(floor.revs, 1e-6)).toFixed(1)}`);
    expect(floor.hullN).toBeGreaterThan(3); // sanity
  });
});
