import { describe, it, expect } from 'vitest';
import { SoftBodyWorld } from '../physics/softBodyWorld';
import { vec2 } from '../physics/vec2';
import { TriggerManager } from './triggerManager';
import { TriggerDef } from '../levels/types';

function setupWorldWithAnchor() {
  const world = new SoftBodyWorld();
  // One anchored particle at the origin (mass 0 → invMass 0).
  const pid = world.addParticle(vec2(0, 0), vec2(0, 0), 0, 0);
  const particles = new Map<string, number[]>([['s', [pid]]]);
  return { world, particles, pid };
}

describe('TriggerManager', () => {
  it('does not move points until fire() is called', () => {
    const { world, particles } = setupWorldWithAnchor();
    const triggers: TriggerDef[] = [{
      id: 't1',
      kind: 'movePoints',
      targets: [{ shapeId: 's', pointIndex: 0, endX: 100, endY: 0 }],
      duration: 1.0,
      easing: 'linear',
    }];
    const mgr = new TriggerManager();
    mgr.initialize(world, triggers, particles);

    mgr.update(0.5);

    expect(world.pos[0].x).toBe(0);
    expect(world.pos[0].y).toBe(0);
  });

  it('interpolates a point from start to end over the configured duration', () => {
    const { world, particles, pid } = setupWorldWithAnchor();
    const triggers: TriggerDef[] = [{
      id: 't1',
      kind: 'movePoints',
      targets: [{ shapeId: 's', pointIndex: 0, endX: 100, endY: 0 }],
      duration: 1.0,
      easing: 'linear',
    }];
    const mgr = new TriggerManager();
    mgr.initialize(world, triggers, particles);

    mgr.fire('t1');
    mgr.update(0.5);
    expect(world.pos[pid].x).toBeCloseTo(50, 5);

    mgr.update(0.5);
    expect(world.pos[pid].x).toBeCloseTo(100, 5);
  });

  it('clamps motion at the end position once duration elapses', () => {
    const { world, particles, pid } = setupWorldWithAnchor();
    const triggers: TriggerDef[] = [{
      id: 't1',
      kind: 'movePoints',
      targets: [{ shapeId: 's', pointIndex: 0, endX: 200, endY: -50 }],
      duration: 0.5,
      easing: 'linear',
    }];
    const mgr = new TriggerManager();
    mgr.initialize(world, triggers, particles);

    mgr.fire('t1');
    mgr.update(10); // way past duration

    expect(world.pos[pid].x).toBe(200);
    expect(world.pos[pid].y).toBe(-50);
  });

  it('fire() on unknown trigger id is a no-op', () => {
    const { world, particles } = setupWorldWithAnchor();
    const mgr = new TriggerManager();
    mgr.initialize(world, [], particles);

    expect(() => mgr.fire('nope')).not.toThrow();
    mgr.update(1);
    expect(world.pos[0].x).toBe(0);
  });

  it('zeros velocity on anchored points so the solver does not drift them', () => {
    const { world, particles, pid } = setupWorldWithAnchor();
    world.vel[pid] = vec2(999, 999);
    const triggers: TriggerDef[] = [{
      id: 't1',
      kind: 'movePoints',
      targets: [{ shapeId: 's', pointIndex: 0, endX: 100, endY: 0 }],
      duration: 1.0,
      easing: 'linear',
    }];
    const mgr = new TriggerManager();
    mgr.initialize(world, triggers, particles);

    mgr.fire('t1');
    mgr.update(0.1);

    expect(world.vel[pid].x).toBe(0);
    expect(world.vel[pid].y).toBe(0);
  });
});
