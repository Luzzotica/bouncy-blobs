import { SoftBodyWorld } from '../physics/softBodyWorld';
import { SlimeBlob } from '../physics/slimeBlob';
import { Vec2, vec2 } from '../physics/vec2';
import { rect as hullRect, rectAnchorIndices } from '../physics/hullPresets';
import * as Tuning from '../physics/tuning';
import { LevelData, PlatformDef, PressurePlateDef, SoftPlatformDef, ZoneDef } from './types';

export interface SoftPlatformInfo {
  id: string;
  blobId: number;
  hullIndices: number[];
  staticHullIndices: number[];
}

export interface LoadedLevel {
  playerSpawnPoints: Vec2[];
  npcBlobs: SlimeBlob[];
  /** Map from zone id to trigger shape index in the physics world. */
  triggerIndices: Map<string, number>;
  /** Map from PointShape id → ordered list of particle indices in the world. */
  pointShapeParticles: Map<string, number[]>;
  /** Map from soft-platform id → ordered list of its STATIC hull particle
   * indices in the world. Used by triggers that animate platform anchors. */
  softPlatformStaticParticles: Map<string, number[]>;
  /** All soft platforms in load order. For rendering. */
  softPlatforms: SoftPlatformInfo[];
  /** Map from physics-world trigger shape index → pressure plate id. */
  plateShapeIdxToId: Map<number, string>;
}

const POINT_SHAPE_DEFAULT_K = 600;
const POINT_SHAPE_DEFAULT_DAMP = 12;
const POINT_SHAPE_DEFAULT_MASS = 1;
const POINT_SHAPE_PARTICLE_RADIUS = 5;
// Home-position pull: how hard each unanchored point is yanked back to its
// rest world coordinates. This is what makes a point-shape feel like it has
// a "memory" of its shape rather than a loose mesh of springs.
const POINT_SHAPE_HOME_K = 1800;
const POINT_SHAPE_HOME_DAMP = 18;

function plateToPolygon(p: PressurePlateDef): Vec2[] {
  const tw = p.triggerWidth ?? p.width;
  const th = p.triggerHeight ?? p.height;
  const hw = tw / 2;
  const hh = th / 2;
  // Bottom of the trigger zone stays aligned with the bottom of the visual
  // plate (so an extra-tall trigger extends upward where blobs come from).
  const visualBottomY = p.height / 2;
  const triggerCenterYOffset = visualBottomY - hh;
  const corners: Vec2[] = [
    vec2(-hw, -hh + triggerCenterYOffset),
    vec2(hw, -hh + triggerCenterYOffset),
    vec2(hw, hh + triggerCenterYOffset),
    vec2(-hw, hh + triggerCenterYOffset),
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

  // Gravity-field trigger zones (black holes, directional shifts, etc.)
  for (const gz of level.gravityZones ?? []) {
    const hw = gz.width / 2;
    const hh = gz.height / 2;
    const poly: Vec2[] = [
      vec2(gz.x - hw, gz.y - hh),
      vec2(gz.x + hw, gz.y - hh),
      vec2(gz.x + hw, gz.y + hh),
      vec2(gz.x - hw, gz.y + hh),
    ];
    const shapeIdx = world.registerTriggerPolygon(poly, gz.field);
    triggerIndices.set(gz.id, shapeIdx);
  }

  // Hydrate point shapes: each point becomes a particle, each edge a spring.
  // Anchored points use mass=0 → invMass=0 (fixed in space). Each unanchored
  // point also gets a home-position pull so the shape resists deformation
  // independent of edge tension.
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
      if (!p.anchored) {
        world.homeAnchors.push({
          idx: id,
          home: vec2(p.x, p.y),
          k: POINT_SHAPE_HOME_K,
          damp: POINT_SHAPE_HOME_DAMP,
        });
      }
    }
    const pushEdge = (a: number, b: number, k?: number, damp?: number) => {
      if (a === b) return;
      const pa = ps.points[a];
      const pb = ps.points[b];
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const rest = Math.sqrt(dx * dx + dy * dy);
      world.extraSprings.push([
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

  // Hydrate soft platforms: each is a regular blob with a subdivided
  // rectangular hull and certain hull points locked as static.
  const softPlatformStaticParticles = new Map<string, number[]>();
  const softPlatforms: SoftPlatformInfo[] = [];
  for (const sp of level.softPlatforms ?? []) {
    const info = expandSoftPlatform(world, sp, softPlatformStaticParticles);
    softPlatforms.push(info);
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
    softPlatformStaticParticles,
    softPlatforms,
    plateShapeIdxToId,
  };
}

function expandSoftPlatform(
  world: SoftBodyWorld,
  def: SoftPlatformDef,
  staticParticleMap: Map<string, number[]>,
): SoftPlatformInfo {
  const segW = def.segW ?? 8;
  const segH = def.segH ?? 1;
  let hullLocal = hullRect(def.width, def.height, segW, segH);
  // Pre-rotate the hull around its center so anchored corners + free vertices
  // end up at their world-rotated rest positions.
  const rot = def.rotation ?? 0;
  if (Math.abs(rot) > 0.0001) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    hullLocal = hullLocal.map(p => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
  }

  // Resolve anchor pattern → set of hull indices.
  let anchorIdxs: number[];
  if (Array.isArray(def.anchors)) {
    anchorIdxs = def.anchors;
  } else {
    anchorIdxs = rectAnchorIndices(segW, segH, def.anchors ?? 'corners');
  }

  const stiffness = def.stiffness ?? 1.0;

  const result = world.addBlobFromHull({
    hullRestLocal: hullLocal,
    centerLocal: { x: 0, y: 0 },
    centerMass: Tuning.CENTER_MASS * 12,   // platforms are heavy
    hullMass: Tuning.HULL_MASS * 12,
    springK: Tuning.SPRING_K * 10 * stiffness,
    springDamp: Tuning.SPRING_DAMP * 4,
    radialK: Tuning.RADIAL_K * 10 * stiffness,
    radialDamp: Tuning.RADIAL_DAMP * 4,
    pressureK: 0.0,                        // platforms don't puff
    shapeMatchK: Tuning.SHAPE_MATCH_K * 8 * stiffness,
    shapeMatchDamp: Tuning.SHAPE_MATCH_DAMP * 4,
    worldOrigin: vec2(def.x, def.y),
    staticHullIndices: anchorIdxs,
  });

  // Track static hull particle world-indices for trigger animation.
  const staticParticles = anchorIdxs.map(i => result.hullIndices[i]);
  staticParticleMap.set(def.id, staticParticles);

  return {
    id: def.id,
    blobId: result.blobId,
    hullIndices: result.hullIndices,
    staticHullIndices: staticParticles,
  };
}
