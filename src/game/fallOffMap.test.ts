// Validates the fall-off-the-map kill plane: a blob that drops below the lowest
// map geometry (AABB bottom + 100) must die, while one resting on the map must
// not. Uses the real Rust physics engine + loadLevel + SpikeManager + the same
// computeMapAABB the game uses, over the purpose-built `fallTestLevel`.

import { describe, it, expect, beforeAll } from 'vitest';
import { loadWasmForTests } from '../physics/testWasm';
import { SoftBodyWorldRust } from '../physics/softBodyWorldRust';
import { loadLevel } from '../levels/levelLoader';
import { PlayerManager } from './playerManager';
import { SpikeManager } from './spikeManager';
import { computeMapAABB, FALL_KILL_MARGIN } from './mapBounds';
import { fallTestLevel } from '../levels/fallTestLevel';

const DT = 1 / 60;

function setup() {
  const world = new SoftBodyWorldRust({ rngSeed: 7, gravity: { x: 0, y: 3920 } });
  const loaded = loadLevel(world, fallTestLevel);
  const players = new PlayerManager(loaded.playerSpawnPoints);
  const mapBounds = computeMapAABB(
    world, fallTestLevel,
    loaded.platformSurfaces, loaded.softPlatforms, loaded.pointShapes, loaded.playerSpawnPoints,
  );
  const spikes = new SpikeManager();
  spikes.initialize(world, players, fallTestLevel.spikes ?? [], loaded.npcBlobs);
  // no_respawn so the first kill sticks and isDead() stays true for the assert.
  spikes.deathMode = 'no_respawn';
  spikes.setKillBelowY(mapBounds.maxY + FALL_KILL_MARGIN);
  return { world, players, spikes, mapBounds, npcBlobs: loaded.npcBlobs };
}

function step(
  world: SoftBodyWorldRust, players: PlayerManager, spikes: SpikeManager, ticks: number,
): void {
  for (let t = 0; t < ticks; t++) {
    players.updateAll(DT, world);
    world.step(DT);
    spikes.update(DT);
  }
}

describe('fall-off-the-map kill plane', () => {
  beforeAll(async () => { await loadWasmForTests(); });

  it('places the kill plane 100u below the lowest map geometry', () => {
    const { mapBounds } = setup();
    // Ledge spans y[-50,50]; spawns sit above it, so the lowest geometry is the
    // ledge bottom at y=50 → kill plane at 150.
    expect(mapBounds.maxY).toBe(50);
  });

  it('kills a blob that falls off the map into the void', () => {
    const { world, players, spikes, mapBounds } = setup();
    const faller = players.addPlayer('faller', 'Faller', world);
    world.teleportBlob(faller.blob.blobId, { x: 2000, y: -200 });

    expect(spikes.isDead('faller')).toBe(false);   // alive at the start of the fall
    step(world, players, spikes, 180);             // ~3s of free fall
    expect(spikes.isDead('faller')).toBe(true);    // dropped past the kill plane → dead
  });

  it('does NOT kill a blob resting safely on the map', () => {
    const { world, players, spikes } = setup();
    const safe = players.addPlayer('safe', 'Safe', world);
    world.teleportBlob(safe.blob.blobId, { x: 0, y: -200 });

    step(world, players, spikes, 180);             // lands on the ledge and settles
    expect(spikes.isDead('safe')).toBe(false);
    expect(safe.blob.getCentroid().y).toBeLessThan(150); // stayed above the kill plane
  });

  it('kills an NPC blob that falls off the map', () => {
    const { world, players, spikes, npcBlobs } = setup();
    const npc = npcBlobs[0];
    expect(npc).toBeTruthy();
    expect(npc.destroyed).toBe(false);   // alive at the start of its fall

    // No players needed; the NPC free-falls from its spawn over the void.
    step(world, players, spikes, 180);

    expect(npc.destroyed).toBe(true);    // dropped past the kill plane → retired
  });

  it('does not retire an NPC while the kill plane is disabled', () => {
    const { world, players, spikes, npcBlobs } = setup();
    spikes.setKillBelowY(null);
    step(world, players, spikes, 180);
    expect(npcBlobs[0].destroyed).toBe(false);
  });

  it('only the kill plane is responsible — with it disabled, the same fall does not kill', () => {
    const { world, players, spikes } = setup();
    spikes.setKillBelowY(null);                    // turn the fall-off plane off
    const faller = players.addPlayer('faller', 'Faller', world);
    world.teleportBlob(faller.blob.blobId, { x: 2000, y: -200 });

    step(world, players, spikes, 180);
    expect(spikes.isDead('faller')).toBe(false);   // free fall alone never kills
  });
});
