import { describe, it, expect, beforeAll } from 'vitest';
import { SoftBodyWorldRust } from '../physics/softBodyWorldRust';
import { loadWasmForTests } from '../physics/testWasm';
import { vec2 } from '../physics/vec2';
import { TriggerManager } from './triggerManager';
import { TriggerDef } from '../levels/types';

beforeAll(async () => { await loadWasmForTests(); });

function setup(opts: { chargeSeconds?: number } = {}) {
  const world = new SoftBodyWorldRust();
  const def: TriggerDef = {
    id: 't1', x: 0, y: 100, width: 50, height: 10, rotation: 0,
    chargeSeconds: opts.chargeSeconds,
  };
  const shapeIdx = world.registerTriggerPolygon([
    vec2(-25, 95), vec2(25, 95), vec2(25, 105), vec2(-25, 105),
  ]);
  const shapeIdxToId = new Map<number, string>([[shapeIdx, def.id]]);

  const mgr = new TriggerManager();
  mgr.initialize(world, [def], shapeIdxToId);
  return { world, mgr, shapeIdx };
}

describe('TriggerManager (area)', () => {
  it('hooks world.onTriggerEntered/onTriggerExited', () => {
    const { world } = setup();
    expect(world.onTriggerEntered).toBeTypeOf('function');
    expect(world.onTriggerExited).toBeTypeOf('function');
  });

  it('chargeSeconds=0 → pressed flips immediately on first enter', () => {
    const { world, mgr, shapeIdx } = setup();
    expect(mgr.isPressed('t1')).toBe(false);
    world.onTriggerEntered!(shapeIdx, 42);
    expect(mgr.isPressed('t1')).toBe(true);
  });

  it('pressed flips back to false when the last occupant leaves', () => {
    const { world, mgr, shapeIdx } = setup();
    world.onTriggerEntered!(shapeIdx, 1);
    world.onTriggerEntered!(shapeIdx, 2);
    world.onTriggerExited!(shapeIdx, 1);
    expect(mgr.isPressed('t1')).toBe(true);   // one blob still on
    world.onTriggerExited!(shapeIdx, 2);
    expect(mgr.isPressed('t1')).toBe(false);  // empty → released
  });

  it('chargeSeconds > 0: pressed flips only after the hold duration elapses', () => {
    const { world, mgr, shapeIdx } = setup({ chargeSeconds: 0.5 });
    world.onTriggerEntered!(shapeIdx, 1);
    mgr.update(0.2);
    expect(mgr.isPressed('t1')).toBe(false);
    expect(mgr.chargeProgress('t1')).toBeCloseTo(0.4, 5);
    mgr.update(0.4);   // total 0.6 ≥ 0.5
    expect(mgr.isPressed('t1')).toBe(true);
  });

  it('exiting mid-charge resets chargeElapsed to zero', () => {
    const { world, mgr, shapeIdx } = setup({ chargeSeconds: 0.5 });
    world.onTriggerEntered!(shapeIdx, 1);
    mgr.update(0.3);
    expect(mgr.chargeProgress('t1')).toBeGreaterThan(0);
    world.onTriggerExited!(shapeIdx, 1);
    expect(mgr.chargeProgress('t1')).toBe(0);

    // Re-entering starts charging from zero again.
    world.onTriggerEntered!(shapeIdx, 2);
    mgr.update(0.4);
    expect(mgr.isPressed('t1')).toBe(false);  // would have fired if progress carried over
    mgr.update(0.2);
    expect(mgr.isPressed('t1')).toBe(true);
  });
});
