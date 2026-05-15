import { SoftBodyWorld } from '../physics/softBodyWorld';
import { SlimeBlob } from '../physics/slimeBlob';
import { Vec2, vec2 } from '../physics/vec2';
import { LevelData, PlatformDef, PressurePlateDef, ZoneDef } from './types';

export interface LoadedLevel {
  playerSpawnPoints: Vec2[];
  npcBlobs: SlimeBlob[];
  /** Map from zone id to trigger shape index in the physics world. */
  triggerIndices: Map<string, number>;
  /** Map from PointShape id → ordered list of particle indices in the world. */
  pointShapeParticles: Map<string, number[]>;
  /** Map from physics-world trigger shape index → pressure plate id. */
  plateShapeIdxToId: Map<number, string>;
}

const POINT_SHAPE_DEFAULT_K = 600;
const POINT_SHAPE_DEFAULT_DAMP = 12;
const POINT_SHAPE_DEFAULT_MASS = 1;
const POINT_SHAPE_PARTICLE_RADIUS = 5;

function plateToPolygon(p: PressurePlateDef): Vec2[] {
  const hw = p.width / 2;
  const hh = p.height / 2;
  const corners: Vec2[] = [
    vec2(-hw, -hh),
    vec2(hw, -hh),
    vec2(hw, hh),
    vec2(-hw, hh),
  ];
  if (Math.abs(p.rotation) > 0.001) {
    const c = Math.cos(p.rotation);
    const s = Math.sin(p.rotation);
    return corners.map(v => vec2(v.x * c - v.y * s + p.x, v.x * s + v.y * c + p.y));
  }
  return corners.map(v => vec2(v.x + p.x, v.y + p.y));
}

function platformToPolygon(p: PlatformDef): Vec2[] {
  const hw = p.width / 2;
  const hh = p.height / 2;
  const corners: Vec2[] = [
    vec2(-hw, -hh),
    vec2(hw, -hh),
    vec2(hw, hh),
    vec2(-hw, hh),
  ];

  if (Math.abs(p.rotation) > 0.001) {
    const c = Math.cos(p.rotation);
    const s = Math.sin(p.rotation);
    return corners.map(v => vec2(
      v.x * c - v.y * s + p.x,
      v.x * s + v.y * c + p.y,
    ));
  }
  return corners.map(v => vec2(v.x + p.x, v.y + p.y));
}

export function loadLevel(world: SoftBodyWorld, level: LevelData): LoadedLevel {
  // Register platforms
  for (const platform of level.platforms) {
    world.registerStaticPolygon(platformToPolygon(platform), platform.material ?? 'default', platform.id);
  }

  // Register walls
  for (const wall of level.walls) {
    world.registerStaticPolygon(wall.points.map(p => vec2(p.x, p.y)), wall.material ?? 'default', wall.id);
  }

  // Spawn NPC blobs
  const npcBlobs: SlimeBlob[] = [];
  for (const npc of level.npcBlobs) {
    const blob = new SlimeBlob(world, vec2(npc.x, npc.y), {
      playerControlled: false,
      hullPreset: npc.hullPreset,
    });
    npcBlobs.push(blob);
  }

  // Register goal/hill zones as trigger polygons
  const triggerIndices = new Map<string, number>();
  const allZones: ZoneDef[] = [
    ...(level.goalZones ?? []),
    ...(level.hillZones ?? []),
  ];
  for (const zone of allZones) {
    const hw = zone.width / 2;
    const hh = zone.height / 2;
    const poly: Vec2[] = [
      vec2(zone.x - hw, zone.y - hh),
      vec2(zone.x + hw, zone.y - hh),
      vec2(zone.x + hw, zone.y + hh),
      vec2(zone.x - hw, zone.y + hh),
    ];
    const shapeIdx = world.registerTriggerPolygon(poly);
    triggerIndices.set(zone.id, shapeIdx);
  }

  // Hydrate point shapes: each point becomes a particle, each edge a spring.
  // Anchored points use mass=0 → invMass=0 (fixed in space).
  const pointShapeParticles = new Map<string, number[]>();
  for (const ps of level.pointShapes ?? []) {
    const ids: number[] = [];
    for (const p of ps.points) {
      const mass = p.anchored ? 0 : (p.mass ?? POINT_SHAPE_DEFAULT_MASS);
      const id = world.addParticle(
        vec2(p.x, p.y),
        vec2(0, 0),
        mass,
        POINT_SHAPE_PARTICLE_RADIUS,
      );
      ids.push(id);
    }
    const pushEdge = (a: number, b: number, k?: number, damp?: number) => {
      if (a === b) return;
      const pa = ps.points[a];
      const pb = ps.points[b];
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const rest = Math.sqrt(dx * dx + dy * dy);
      world.springs.push([
        ids[a],
        ids[b],
        rest,
        k ?? POINT_SHAPE_DEFAULT_K,
        damp ?? POINT_SHAPE_DEFAULT_DAMP,
      ]);
    };
    for (const e of ps.edges) pushEdge(e.a, e.b, e.stiffness, e.damping);
    if (ps.closed && ps.points.length > 2) {
      pushEdge(ps.points.length - 1, 0);
    }
    pointShapeParticles.set(ps.id, ids);
  }

  // Register pressure plates as trigger polygons so blob entry fires callbacks.
  const plateShapeIdxToId = new Map<number, string>();
  for (const plate of level.pressurePlates ?? []) {
    const shapeIdx = world.registerTriggerPolygon(plateToPolygon(plate));
    plateShapeIdxToId.set(shapeIdx, plate.id);
  }

  // Collect player spawn points
  const playerSpawnPoints = level.spawnPoints
    .filter(sp => sp.type === 'player')
    .map(sp => vec2(sp.x, sp.y));

  return {
    playerSpawnPoints,
    npcBlobs,
    triggerIndices,
    pointShapeParticles,
    plateShapeIdxToId,
  };
}
