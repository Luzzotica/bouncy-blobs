import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SoftBodyWorld } from '../physics/softBodyWorld';
import { TriggerManager } from '../game/triggerManager';
import { PressurePlateManager } from '../game/pressurePlateManager';
import { loadLevel } from './levelLoader';
import { LevelData } from './types';

function loadShowcase(): LevelData {
  const p = resolve(__dirname, '../../public/levels/showcase.json');
  return JSON.parse(readFileSync(p, 'utf-8')) as LevelData;
}

describe('showcase level — covers every element type', () => {
  const level = loadShowcase();

  it('declares at least one of every element category', () => {
    expect(level.platforms.length).toBeGreaterThan(0);
    expect(level.walls.length).toBeGreaterThan(0);
    expect(level.spawnPoints.length).toBeGreaterThan(0);
    expect(level.npcBlobs.length).toBeGreaterThan(0);
    expect(level.spikes?.length ?? 0).toBeGreaterThan(0);
    expect(level.springPads?.length ?? 0).toBeGreaterThan(0);
    expect(level.goalZones?.length ?? 0).toBeGreaterThan(0);
    expect(level.hillZones?.length ?? 0).toBeGreaterThan(0);
    expect(level.powerupSpawns?.length ?? 0).toBeGreaterThan(0);
    expect(level.pointShapes?.length ?? 0).toBeGreaterThan(0);
    expect(level.pressurePlates?.length ?? 0).toBeGreaterThan(0);
    expect(level.triggers?.length ?? 0).toBeGreaterThan(0);
  });

  it('exercises every NPC hull preset at least once', () => {
    const presets = new Set(level.npcBlobs.map(n => n.hullPreset));
    for (const expected of ['circle16', 'square', 'triangle', 'star', 'diamond', 'hexagon']) {
      expect(presets.has(expected as any)).toBe(true);
    }
  });

  it('contains both player and npc spawn point types', () => {
    const types = new Set(level.spawnPoints.map(s => s.type));
    expect(types.has('player')).toBe(true);
    expect(types.has('npc')).toBe(true);
  });

  it('includes a closed PointShape and an open one with mixed anchored / dynamic points', () => {
    const closed = level.pointShapes!.filter(p => p.closed);
    expect(closed.length).toBeGreaterThan(0);

    const hasMixed = level.pointShapes!.some(ps =>
      ps.points.some(p => p.anchored) && ps.points.some(p => !p.anchored),
    );
    expect(hasMixed).toBe(true);
  });

  it('includes a one-shot pressure plate and a re-fireable one', () => {
    const plates = level.pressurePlates!;
    expect(plates.some(p => p.oneShot)).toBe(true);
    expect(plates.some(p => !p.oneShot)).toBe(true);
  });

  it('every plate trigger reference resolves to a defined trigger', () => {
    const triggerIds = new Set(level.triggers!.map(t => t.id));
    for (const plate of level.pressurePlates!) {
      for (const tid of plate.triggerIds) {
        expect(triggerIds.has(tid)).toBe(true);
      }
    }
  });

  it('every trigger target refers to a real point on a real shape', () => {
    const byId = new Map(level.pointShapes!.map(s => [s.id, s]));
    for (const trig of level.triggers!) {
      for (const t of trig.targets) {
        const shape = byId.get(t.shapeId);
        expect(shape, `shape ${t.shapeId} missing`).toBeDefined();
        expect(t.pointIndex).toBeGreaterThanOrEqual(0);
        expect(t.pointIndex).toBeLessThan(shape!.points.length);
      }
    }
  });

  it('loads cleanly into the runtime and a plate can fire a trigger that moves the right particle', () => {
    const world = new SoftBodyWorld();
    const loaded = loadLevel(world, level);

    // Sanity — every PointShape mapped to particles.
    for (const ps of level.pointShapes!) {
      expect(loaded.pointShapeParticles.get(ps.id)?.length).toBe(ps.points.length);
    }

    const triggerMgr = new TriggerManager();
    triggerMgr.initialize(world, level.triggers ?? [], loaded.pointShapeParticles);
    const plateMgr = new PressurePlateManager();
    plateMgr.initialize(world, level.pressurePlates ?? [], loaded.plateShapeIdxToId, triggerMgr);

    // Find the plate-bridge plate and its associated trigger shape index.
    const bridgePlateId = 'plate-bridge';
    let shapeIdx = -1;
    for (const [idx, id] of loaded.plateShapeIdxToId) {
      if (id === bridgePlateId) { shapeIdx = idx; break; }
    }
    expect(shapeIdx).toBeGreaterThanOrEqual(0);

    // Capture the start position of the bridge anchor that the trigger moves (pointIndex 0).
    const bridgeIds = loaded.pointShapeParticles.get('rope-bridge')!;
    const anchorPid = bridgeIds[0];
    const startY = world.pos[anchorPid].y;

    // Simulate a blob stepping on the plate, then run a long update.
    world.onTriggerEntered!(shapeIdx, 0);
    triggerMgr.update(10);

    // After the tween, anchor should have lifted to endY=1300 (well above startY=1680).
    expect(world.pos[anchorPid].y).toBeCloseTo(1300, 1);
    expect(world.pos[anchorPid].y).toBeLessThan(startY);
  });
});
