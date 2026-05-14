import { describe, it, expect } from 'vitest';
import { SoftBodyWorld } from '../physics/softBodyWorld';
import { loadLevel } from './levelLoader';
import { LevelData } from './types';

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

describe('levelLoader — PointShape hydration', () => {
  it('creates one particle per point and one spring per edge', () => {
    const world = new SoftBodyWorld();
    const level: LevelData = {
      ...emptyLevel(),
      pointShapes: [{
        id: 'bridge',
        points: [
          { x: -100, y: 0, anchored: true },
          { x: 0, y: 0, anchored: false },
          { x: 100, y: 0, anchored: true },
        ],
        edges: [
          { a: 0, b: 1 },
          { a: 1, b: 2 },
        ],
      }],
    };

    const loaded = loadLevel(world, level);

    expect(world.pos.length).toBe(3);
    expect(world.springs.length).toBe(2);
    const ids = loaded.pointShapeParticles.get('bridge')!;
    expect(ids).toEqual([0, 1, 2]);
  });

  it('anchored points get invMass=0; dynamic points get invMass>0', () => {
    const world = new SoftBodyWorld();
    const level: LevelData = {
      ...emptyLevel(),
      pointShapes: [{
        id: 's',
        points: [
          { x: 0, y: 0, anchored: true },
          { x: 50, y: 0, anchored: false },
          { x: 100, y: 0, anchored: false, mass: 2 },
        ],
        edges: [],
      }],
    };

    loadLevel(world, level);

    expect(world.invMass[0]).toBe(0);
    expect(world.invMass[1]).toBeGreaterThan(0);
    expect(world.invMass[2]).toBeCloseTo(0.5, 5); // mass 2 → invMass 0.5
  });

  it('spring rest length equals the authored distance between points', () => {
    const world = new SoftBodyWorld();
    const level: LevelData = {
      ...emptyLevel(),
      pointShapes: [{
        id: 's',
        points: [
          { x: 0, y: 0, anchored: true },
          { x: 30, y: 40, anchored: false }, // distance 50
        ],
        edges: [{ a: 0, b: 1 }],
      }],
    };

    loadLevel(world, level);

    const [, , rest] = world.springs[0];
    expect(rest).toBeCloseTo(50, 5);
  });

  it('closed=true appends an implicit last→first edge', () => {
    const world = new SoftBodyWorld();
    const level: LevelData = {
      ...emptyLevel(),
      pointShapes: [{
        id: 's',
        points: [
          { x: 0, y: 0, anchored: false },
          { x: 100, y: 0, anchored: false },
          { x: 50, y: 100, anchored: false },
        ],
        edges: [{ a: 0, b: 1 }, { a: 1, b: 2 }],
        closed: true,
      }],
    };

    loadLevel(world, level);

    expect(world.springs.length).toBe(3);
    const last = world.springs[2];
    // Closing edge connects particle 2 → particle 0
    expect(last[0]).toBe(2);
    expect(last[1]).toBe(0);
  });
});

describe('levelLoader — PressurePlate registration', () => {
  it('registers each plate as a trigger polygon and indexes shape→plateId', () => {
    const world = new SoftBodyWorld();
    const level: LevelData = {
      ...emptyLevel(),
      pressurePlates: [
        { id: 'plate1', x: 0, y: 0, width: 100, height: 20, rotation: 0, triggerIds: [] },
        { id: 'plate2', x: 200, y: 0, width: 100, height: 20, rotation: 0, triggerIds: ['t1'] },
      ],
    };

    const loaded = loadLevel(world, level);

    expect(loaded.plateShapeIdxToId.size).toBe(2);
    const ids = [...loaded.plateShapeIdxToId.values()];
    expect(ids).toContain('plate1');
    expect(ids).toContain('plate2');
    // Each plate should have created exactly one trigger shape in the world.
    const triggerShapes = world.shapes.filter(s => s.isTrigger);
    expect(triggerShapes.length).toBe(2);
  });
});
