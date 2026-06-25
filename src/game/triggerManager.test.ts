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

// ── Regression: structural softbodies must never press triggers ─────────────
// Point shapes, soft platforms and rope-chain segments are all blobs in the
// engine, and the engine emits trigger enter/exit events for EVERY blob. A
// trigger must only respond to player blobs (and NPCs, unless it ignores
// them). These tests build a real engine, park a STATIC softbody shape inside
// a trigger area, step the sim so the engine runs its own occupancy detection,
// and check what actually presses.
describe('TriggerManager — softbody shapes must not press triggers', () => {
  function softbodyInsideTrigger() {
    const world = new SoftBodyWorldRust();
    const def: TriggerDef = { id: 't1', x: 0, y: 100, width: 80, height: 40, rotation: 0 };
    // Trigger area: an 80×40 box centred on (0, 100).
    const shapeIdx = world.registerTriggerPolygon([
      vec2(-40, 80), vec2(40, 80), vec2(40, 120), vec2(-40, 120),
    ]);
    const shapeIdxToId = new Map<number, string>([[shapeIdx, def.id]]);

    // A small, fully-static softbody shape (like a point shape / soft platform)
    // parked squarely inside the trigger area. Every particle is pinned so it
    // can't drift out under gravity during the steps below.
    const blob = world.addBlobFromHull({
      hullRestLocal: [
        { x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 },
      ],
      centerLocal: { x: 0, y: 0 },
      centerMass: 1, hullMass: 1,
      springK: 200, springDamp: 5,
      radialK: 200, radialDamp: 5,
      pressureK: 0,
      shapeMatchK: 200, shapeMatchDamp: 5,
      worldOrigin: vec2(0, 100),
      sortKey: 'pointshape:test',
      staticHullIndices: [0, 1, 2, 3],
      staticCenter: true,
      pinFrame: true,
    });

    return { world, def, shapeIdxToId, softbodyBlobId: blob.blobId };
  }

  // Records which blob ids the ENGINE reports entering the trigger, while
  // still letting the manager's own handler run.
  function recordEngineEnters(world: SoftBodyWorldRust): number[] {
    const seen: number[] = [];
    const prior = world.onTriggerEntered;
    world.onTriggerEntered = (s, b) => { seen.push(b); prior?.(s, b); };
    return seen;
  }

  it('reproduces the bug: an unfiltered trigger IS pressed by a softbody shape', () => {
    const { world, def, shapeIdxToId, softbodyBlobId } = softbodyInsideTrigger();
    const mgr = new TriggerManager();
    // No player/NPC predicates → old permissive behavior (everything presses).
    mgr.initialize(world, [def], shapeIdxToId);
    const engineEnters = recordEngineEnters(world);

    for (let i = 0; i < 3; i++) world.step(1 / 60);

    // The engine reports the softbody shape overlapping the trigger area...
    expect(engineEnters).toContain(softbodyBlobId);
    // ...and without filtering it wrongly presses the trigger. THIS is the bug.
    expect(mgr.isPressed('t1')).toBe(true);
  });

  it('fix: with player/NPC filtering, a softbody shape does NOT press the trigger', () => {
    const { world, def, shapeIdxToId, softbodyBlobId } = softbodyInsideTrigger();
    const mgr = new TriggerManager();
    // Realistic wiring: this blob is neither a player nor an NPC.
    mgr.initialize(world, [def], shapeIdxToId, () => false, () => false);
    const engineEnters = recordEngineEnters(world);

    for (let i = 0; i < 3; i++) world.step(1 / 60);

    // The engine still reports the softbody overlapping the trigger area...
    expect(engineEnters).toContain(softbodyBlobId);
    // ...but the TriggerManager now refuses to let a non-agent press it.
    expect(mgr.isPressed('t1')).toBe(false);
  });

  it('a player blob still presses the trigger', () => {
    const { world, def, shapeIdxToId, softbodyBlobId } = softbodyInsideTrigger();
    const mgr = new TriggerManager();
    // Treat the blob as a player — legitimate presses must still work.
    mgr.initialize(world, [def], shapeIdxToId, () => false, (id) => id === softbodyBlobId);

    for (let i = 0; i < 3; i++) world.step(1 / 60);

    expect(mgr.isPressed('t1')).toBe(true);
  });
});
