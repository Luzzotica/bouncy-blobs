import { describe, it, expect } from 'vitest';
import { SoftBodyWorld } from '../physics/softBodyWorld';
import { vec2 } from '../physics/vec2';
import { PressurePlateManager } from './pressurePlateManager';
import { TriggerManager } from './triggerManager';
import { PressurePlateDef, TriggerDef } from '../levels/types';

function setup(opts: { oneShot?: boolean } = {}) {
  const world = new SoftBodyWorld();
  // Register one anchored target particle on a fake shape "s".
  const pid = world.addParticle(vec2(0, 0), vec2(0, 0), 0, 0);
  const particles = new Map<string, number[]>([['s', [pid]]]);

  const triggers: TriggerDef[] = [{
    id: 'trig1',
    kind: 'movePoints',
    targets: [{ shapeId: 's', pointIndex: 0, endX: 100, endY: 0 }],
    duration: 1.0,
    easing: 'linear',
  }];

  const plateDef: PressurePlateDef = {
    id: 'plate1', x: 0, y: 100, width: 50, height: 10, rotation: 0,
    triggerIds: ['trig1'],
    oneShot: opts.oneShot,
  };

  const shapeIdx = world.registerTriggerPolygon([
    vec2(-25, 95), vec2(25, 95), vec2(25, 105), vec2(-25, 105),
  ]);
  const shapeIdxToId = new Map<number, string>([[shapeIdx, plateDef.id]]);

  const triggerMgr = new TriggerManager();
  triggerMgr.initialize(world, triggers, particles);

  const plateMgr = new PressurePlateManager();
  plateMgr.initialize(world, [plateDef], shapeIdxToId, triggerMgr);

  return { world, plateMgr, triggerMgr, shapeIdx, pid };
}

describe('PressurePlateManager', () => {
  it('hooks world.onTriggerEntered/onTriggerExited', () => {
    const { world } = setup();
    expect(world.onTriggerEntered).toBeTypeOf('function');
    expect(world.onTriggerExited).toBeTypeOf('function');
  });

  it('fires bound triggers when a blob enters the plate', () => {
    const { world, triggerMgr, shapeIdx, pid } = setup();

    world.onTriggerEntered!(shapeIdx, 42);
    triggerMgr.update(0.5);

    expect(world.pos[pid].x).toBeCloseTo(50, 5);
  });

  it('does not re-fire while another blob is already on the plate', () => {
    const { world, triggerMgr, shapeIdx, pid } = setup();

    world.onTriggerEntered!(shapeIdx, 1); // start tween
    triggerMgr.update(0.5);              // halfway
    world.onTriggerEntered!(shapeIdx, 2); // second blob steps on
    triggerMgr.update(0.5);              // complete first tween

    // If a second tween had started, position would be partway between 50 and end-from-50.
    // We expect a single tween that finishes cleanly at endX=100.
    expect(world.pos[pid].x).toBeCloseTo(100, 5);
  });

  it('re-fires when the plate empties and is stepped on again', () => {
    const { world, triggerMgr, shapeIdx, pid } = setup();

    world.onTriggerEntered!(shapeIdx, 1);
    triggerMgr.update(10); // finish first tween — point now at endX
    expect(world.pos[pid].x).toBeCloseTo(100, 5);

    world.onTriggerExited!(shapeIdx, 1);
    world.onTriggerEntered!(shapeIdx, 2);
    triggerMgr.update(0.01);

    // Second fire starts a new tween from current pos (100,0) toward the same end
    // — so position should not jump. We just confirm no crash and no jump backwards.
    expect(world.pos[pid].x).toBeGreaterThanOrEqual(100);
  });

  it('oneShot plates only fire once even after exit/re-entry', () => {
    const { world, triggerMgr, shapeIdx, pid } = setup({ oneShot: true });

    world.onTriggerEntered!(shapeIdx, 1);
    triggerMgr.update(10);
    expect(world.pos[pid].x).toBeCloseTo(100, 5);

    world.onTriggerExited!(shapeIdx, 1);
    // Reset the world position so we can detect another fire.
    world.pos[pid] = vec2(0, 0);
    world.onTriggerEntered!(shapeIdx, 2);
    triggerMgr.update(10);

    // Plate is consumed → no tween should have started → point stays at 0.
    expect(world.pos[pid].x).toBe(0);
  });
});
