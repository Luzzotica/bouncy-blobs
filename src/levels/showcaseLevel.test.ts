import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SoftBodyWorld } from '../physics/softBodyWorld';
import { TriggerManager } from '../game/triggerManager';
import { ActionManager } from '../game/actionManager';
import { PlatformMover } from '../game/platformMover';
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
    expect(level.triggers?.length ?? 0).toBeGreaterThan(0);
    expect(level.actions?.length ?? 0).toBeGreaterThan(0);
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

  it('includes actions covering multiple modes', () => {
    const modes = new Set(level.actions!.map(a => a.mode));
    expect(modes.has('continuous')).toBe(true);
    expect(modes.has('oneShot')).toBe(true);
  });

  it('every action sourceTriggerId resolves to a defined trigger', () => {
    const triggerIds = new Set(level.triggers!.map(t => t.id));
    for (const action of level.actions!) {
      for (const tid of action.sourceTriggerIds) {
        expect(triggerIds.has(tid)).toBe(true);
      }
    }
  });

  it('every action target refers to a real point on a real shape or platform', () => {
    const shapeById = new Map(level.pointShapes!.map(s => [s.id, s]));
    const platformIds = new Set(level.platforms.map(p => p.id));
    for (const action of level.actions!) {
      for (const t of action.targets) {
        if (t.kind === 'shapePoint') {
          const shape = shapeById.get(t.shapeId);
          expect(shape, `shape ${t.shapeId} missing`).toBeDefined();
          expect(t.pointIndex).toBeGreaterThanOrEqual(0);
          expect(t.pointIndex).toBeLessThan(shape!.points.length);
        } else {
          expect(platformIds.has(t.platformId)).toBe(true);
        }
      }
    }
  });

  it('loads cleanly into the runtime and a continuous action raises bridge points while the trigger is occupied', () => {
    const world = new SoftBodyWorld();
    const loaded = loadLevel(world, level);

    // Sanity — every PointShape mapped to particles.
    for (const ps of level.pointShapes!) {
      expect(loaded.pointShapeParticles.get(ps.id)?.length).toBe(ps.points.length);
    }

    const platformMover = new PlatformMover();
    platformMover.initialize(level.platforms, loaded.platformSurfaces);

    const triggerMgr = new TriggerManager();
    triggerMgr.initialize(world, level.triggers ?? [], loaded.triggerShapeIdxToId);

    const actionMgr = new ActionManager();
    actionMgr.initialize(world, level.actions ?? [], loaded.pointShapeParticles, undefined, platformMover, triggerMgr);

    // Find the bridge trigger area's shape index.
    let bridgeShapeIdx = -1;
    for (const [idx, id] of loaded.triggerShapeIdxToId) {
      if (id === 'plate-bridge') { bridgeShapeIdx = idx; break; }
    }
    expect(bridgeShapeIdx).toBeGreaterThanOrEqual(0);

    const bridgeIds = loaded.pointShapeParticles.get('rope-bridge')!;
    const anchorPid = bridgeIds[0];
    const startY = world.pos[anchorPid].y;

    // Simulate a blob stepping on the trigger, then run a long update.
    world.onTriggerEntered!(bridgeShapeIdx, 0);
    // Drive several frames: triggerManager flips pressed; actionManager runs the tween.
    for (let i = 0; i < 200; i++) {
      triggerMgr.update(0.016);
      actionMgr.update(0.016);
    }

    // After a continuous action's open tween, anchor should have risen toward endY=1300.
    expect(world.pos[anchorPid].y).toBeCloseTo(1300, 1);
    expect(world.pos[anchorPid].y).toBeLessThan(startY);
  });
});
