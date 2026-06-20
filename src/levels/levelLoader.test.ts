import { describe, it, expect, beforeAll } from 'vitest';
import { SoftBodyWorldRust } from '../physics/softBodyWorldRust';
import { loadWasmForTests } from '../physics/testWasm';
import { loadLevel } from './levelLoader';
import { LevelData } from './types';

beforeAll(async () => { await loadWasmForTests(); });

function emptyLevel(): LevelData {
  return {
    name: 'test',
    version: 1,
    bounds: { width: 1000, height: 1000 },
    platforms: [],
    walls: [],
    spawnPoints: [{ id: 'sp1', x: 0, y: 0, type: 'player' }],
    npcBlobs: [],
  };
}

describe('levelLoader — PointShape hydration (soft-blob)', () => {
  it('expands a closed hull into a soft-body blob: 1 center + N hull particles', () => {
    const world = new SoftBodyWorldRust();
    const level: LevelData = {
      ...emptyLevel(),
      pointShapes: [{
        id: 'tri',
        points: [
          { x: 0, y: -100, anchored: false },
          { x: 100, y: 50, anchored: false },
          { x: -100, y: 50, anchored: false },
        ],
        edges: [],
        closed: true,
      }],
    };

    const loaded = loadLevel(world, level);

    // 1 center particle + 3 hull particles
    expect(world.pos.length).toBe(4);
    const info = loaded.pointShapes[0];
    expect(info.id).toBe('tri');
    expect(info.hullIndices).toHaveLength(3);
  });

  it('anchored points become static hull particles (invMass=0)', () => {
    const world = new SoftBodyWorldRust();
    const level: LevelData = {
      ...emptyLevel(),
      pointShapes: [{
        id: 's',
        points: [
          { x: 0, y: -100, anchored: true },
          { x: 100, y: 50, anchored: false },
          { x: -100, y: 50, anchored: false },
        ],
        edges: [],
        closed: true,
      }],
    };

    loadLevel(world, level);

    // Find the static hull particle — should have invMass 0; the other two > 0.
    const hullInvs = [world.invMass[1], world.invMass[2], world.invMass[3]];
    const zeroCount = hullInvs.filter(m => m === 0).length;
    const dynamicCount = hullInvs.filter(m => m > 0).length;
    expect(zeroCount).toBe(1);
    expect(dynamicCount).toBe(2);
  });

  it('skips degenerate (<3 points) shapes', () => {
    const world = new SoftBodyWorldRust();
    const level: LevelData = {
      ...emptyLevel(),
      pointShapes: [{
        id: 's',
        points: [{ x: 0, y: 0, anchored: false }, { x: 50, y: 0, anchored: false }],
        edges: [],
      }],
    };

    const loaded = loadLevel(world, level);
    expect(loaded.pointShapes).toHaveLength(0);
    expect(world.pos.length).toBe(0);
  });

  it('reverses CW point rings so the hull is CCW for the engine', () => {
    const world = new SoftBodyWorldRust();
    // CW triangle in screen coords (y-down): vertices ordered clockwise.
    const level: LevelData = {
      ...emptyLevel(),
      pointShapes: [{
        id: 'cw',
        points: [
          { x: 0, y: -100, anchored: false },
          { x: -100, y: 50, anchored: false },
          { x: 100, y: 50, anchored: false },
        ],
        edges: [],
        closed: true,
      }],
    };

    const loaded = loadLevel(world, level);
    // Still produces a valid blob: 1 center + 3 hull particles.
    expect(loaded.pointShapes).toHaveLength(1);
    expect(world.pos.length).toBe(4);
  });
});

describe('levelLoader — Chain hydration', () => {
  it('creates a rope between two fixed anchors with inner segment particles', () => {
    const world = new SoftBodyWorldRust();
    const level: LevelData = {
      ...emptyLevel(),
      chains: [{
        id: 'rope',
        endpointA: { kind: 'fixed', x: 0, y: 0 },
        endpointB: { kind: 'fixed', x: 100, y: 0 },
        totalLength: 100,
        maxSegmentLength: 25,
      }],
    };

    const loaded = loadLevel(world, level);
    expect(loaded.chains).toHaveLength(1);
    const chain = loaded.chains[0];
    // Endpoints + at least 1 inner segment particle.
    expect(chain.particleIndices.length).toBeGreaterThanOrEqual(3);
    // Fixed-anchor endpoints are static (mass = 0).
    expect(world.invMass[chain.particleIndices[0]]).toBe(0);
    expect(world.invMass[chain.particleIndices[chain.particleIndices.length - 1]]).toBe(0);
  });

  it('drops chains whose endpoint references a missing blob', () => {
    const world = new SoftBodyWorldRust();
    const level: LevelData = {
      ...emptyLevel(),
      chains: [{
        id: 'orphan',
        endpointA: { kind: 'fixed', x: 0, y: 0 },
        endpointB: { kind: 'blob', entity: 'npc', id: 'does-not-exist' },
        totalLength: 100,
      }],
    };

    const loaded = loadLevel(world, level);
    expect(loaded.chains).toHaveLength(0);
  });
});

describe('levelLoader — Trigger area registration', () => {
  it('registers each trigger as a sensor polygon and indexes shape→triggerId', () => {
    const world = new SoftBodyWorldRust();
    const level: LevelData = {
      ...emptyLevel(),
      triggers: [
        { id: 'trig1', x: 0, y: 0, width: 100, height: 20, rotation: 0 },
        { id: 'trig2', x: 200, y: 0, width: 100, height: 20, rotation: 0 },
      ],
    };

    const loaded = loadLevel(world, level);

    expect(loaded.triggerShapeIdxToId.size).toBe(2);
    const ids = [...loaded.triggerShapeIdxToId.values()];
    expect(ids).toContain('trig1');
    expect(ids).toContain('trig2');
    // Each trigger should have created exactly one trigger shape in the world.
    const triggerShapes = world.shapes.filter(s => s.isTrigger);
    expect(triggerShapes.length).toBe(2);
  });
});
