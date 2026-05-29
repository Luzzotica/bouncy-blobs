import { SoftBodyWorld } from '../physics/softBodyWorld';
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import { SlimeBlob } from '../physics/slimeBlob';
import { Vec2, vec2 } from '../physics/vec2';
import { rect as hullRect, rectAnchorIndices, circle as hullCircle } from '../physics/hullPresets';
import * as Tuning from '../physics/tuning';
import { LevelData, PlatformDef, TriggerDef, SoftPlatformDef, PointShapeDef, ZoneDef, SpriteInstanceDef, ChainDef, ChainAnchorRef } from './types';
import type { StaticSurface } from '../physics/types';
import type { CollisionShape } from '../assets/spriteRegistry';

/** Look up the manifest collision shape for a sprite id. Returning null
 * means "skip this instance's physics" — the visual will still render via
 * the sprite registry once the image arrives. Wired by callers to the
 * sprite registry so the loader stays decoupled from any singleton. */
export type GetSpriteShape = (spriteId: string) => CollisionShape | null;

export interface SoftPlatformInfo {
  id: string;
  blobId: number;
  centerIdx: number;
  hullIndices: number[];
  staticHullIndices: number[];
}

export interface PointShapeInfo {
  id: string;
  blobId: number;
  centerIdx: number;
  hullIndices: number[];
  staticHullIndices: number[];
}

export interface ChainInfo {
  id: string;
  /** Particle indices for the full rope: [endpointA, ...inner segments, endpointB].
   *  Renderer just walks this and draws line segments. */
  particleIndices: number[];
  totalLength: number;
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
  /** All point-shape soft blobs in load order. */
  pointShapes: PointShapeInfo[];
  /** All editor-authored chains in load order. */
  chains: ChainInfo[];
  /** Map from physics-world trigger shape index → trigger (area) id. */
  triggerShapeIdxToId: Map<number, string>;
  /** Map from platform id → its registered static surface. Used by `PlatformMover`
   *  to drive position/velocity at runtime. */
  platformSurfaces: Map<string, StaticSurface>;
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

// Tuning multipliers for both soft-platform rectangles and point-shape soft
// blobs. Edge springs stay stiff so the polygon perimeter holds together
// under load. Radial + shape-match are deliberately weak so unanchored
// points droop under gravity instead of snapping rigidly to their rest
// world positions. Per-instance `stiffness` multiplies these — set
// `stiffness > 1` for a sturdier platform.
const PLATFORM_SPRING_K_MUL = 10;
const PLATFORM_SPRING_DAMP_MUL = 4;
const PLATFORM_RADIAL_K_MUL = 1.5;
const PLATFORM_RADIAL_DAMP_MUL = 2;
const PLATFORM_SHAPE_MATCH_K_MUL = 0.6;
const PLATFORM_SHAPE_MATCH_DAMP_MUL = 2;
// `pinned` adds a per-vertex home-spring pulling each unanchored hull
// vertex toward its original rest world position. The job of this spring
// is just to keep the shape from drifting away over time — the blob's
// own internal shape-match springs already restore deformation. Tuned
// SOFT so an impact visibly deforms the hull and lets it wobble before
// settling. At 4000+, every vertex snapped back too fast and the shape
// felt like a rigid statue ("infinite mass"). Lower-K + lower-damp lets
// it act like jelly while still staying anchored at rest.
const PINNED_HOME_K = 400;
const PINNED_HOME_DAMP = 12;
// `frameLocked` is the older "whole-body wobbles on a global spring"
// behavior: shape-match frame is locked to the rest transform, and both
// shape-match K + damp are boosted so the whole body resists drift.
// Distinct from `pinned`: frameLocked is global, pinned is per-vertex.
// Both can be set together.
const FRAME_LOCK_SHAPE_MATCH_K_BOOST = 5;
const FRAME_LOCK_SHAPE_MATCH_DAMP_BOOST = 6;
const PLATFORM_CENTER_MASS_MUL = 12;
const PLATFORM_HULL_MASS_MUL = 12;

function triggerAreaToPolygon(p: TriggerDef): Vec2[] {
  const tw = p.sensorWidth ?? p.width;
  const th = p.sensorHeight ?? p.height;
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

/** Transform anchor-local sprite shape points (x, y in world units, relative
 * to the sprite anchor) into world coords using the instance's scale +
 * rotation + position. Used by every sprite-instance physics path. */
function transformLocal(
  points: ReadonlyArray<{ x: number; y: number }>,
  inst: SpriteInstanceDef,
): Vec2[] {
  const s = inst.scale ?? 1;
  const cos = Math.cos(inst.rotation);
  const sin = Math.sin(inst.rotation);
  return points.map(p => {
    const sx = p.x * s;
    const sy = p.y * s;
    return vec2(inst.x + sx * cos - sy * sin, inst.y + sx * sin + sy * cos);
  });
}

export function loadLevel(
  world: SoftBodyEngine,
  level: LevelData,
  getSpriteShape?: GetSpriteShape,
): LoadedLevel {
  // Register platforms (capture surface handles so they can be moved at runtime).
  const platformSurfaces = new Map<string, StaticSurface>();
  for (const platform of level.platforms) {
    const surface = world.registerStaticPolygon(
      platformToPolygon(platform),
      platform.material ?? 'default',
      platform.id,
    );
    platformSurfaces.set(platform.id, surface);
  }

  // Register walls
  for (const wall of level.walls) {
    world.registerStaticPolygon(wall.points.map(p => vec2(p.x, p.y)), wall.material ?? 'default', wall.id);
  }

  // Spawn NPC blobs. NPC `sortKey` uses the level-defined `npc.id` (which
  // is identical on every client because the level data is identical), so
  // blob-blob collisions involving NPCs iterate in the same order on host
  // and guest regardless of local blob index.
  const npcBlobs: SlimeBlob[] = [];
  for (const npc of level.npcBlobs) {
    const blob = new SlimeBlob(world, vec2(npc.x, npc.y), {
      playerControlled: false,
      hullPreset: npc.hullPreset,
      sortKey: `npc:${npc.id}`,
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

  // Hydrate point shapes as soft-body blobs: each shape's point ring is
  // expanded into a closed hull via `addBlobFromHull` (same pipeline as
  // soft platforms). Anchored points become locked hull particles.
  const pointShapeParticles = new Map<string, number[]>();
  const pointShapes: PointShapeInfo[] = [];
  for (const ps of level.pointShapes ?? []) {
    const info = expandPointShapeAsBlob(world, ps);
    if (!info) continue;
    pointShapes.push(info);
    pointShapeParticles.set(ps.id, info.hullIndices);
  }

  // Register trigger areas (formerly pressure plates) as trigger polygons.
  const triggerShapeIdxToId = new Map<number, string>();
  for (const trig of level.triggers ?? []) {
    const shapeIdx = world.registerTriggerPolygon(triggerAreaToPolygon(trig));
    triggerShapeIdxToId.set(shapeIdx, trig.id);
  }

  // Hydrate soft platforms: each is a regular blob with a subdivided
  // rectangular hull and certain hull points locked as static.
  const softPlatformStaticParticles = new Map<string, number[]>();
  const softPlatforms: SoftPlatformInfo[] = [];
  for (const sp of level.softPlatforms ?? []) {
    const info = expandSoftPlatform(world, sp, softPlatformStaticParticles);
    softPlatforms.push(info);
  }

  // ── Sprite-instance physics ───────────────────────────────────────
  // Decoration props placed via the editor's Sprite tool. Each instance
  // looks up its collision shape in the sprite registry (passed in by the
  // caller as `getSpriteShape`) and registers physics accordingly. Sprites
  // whose collision shape isn't yet known are skipped silently — the
  // visual still renders via the registry once the image arrives.
  if (getSpriteShape && level.sprites && level.sprites.length > 0) {
    for (const inst of level.sprites) {
      const shape = getSpriteShape(inst.spriteId);
      if (!shape) continue;
      const material = inst.material ?? 'default';
      if (shape.kind === 'polygon') {
        if (shape.points.length < 3) continue;
        const local = shape.points.map(p => ({ x: p[0], y: p[1] }));
        const worldPoly = transformLocal(local, inst);
        world.registerStaticPolygon(worldPoly, material, inst.id);
      } else if (shape.kind === 'circle') {
        // Engine has no native circle collider; approximate as a polygon.
        const localPts = hullCircle(24, shape.radius);
        const worldPoly = transformLocal(localPts, inst);
        world.registerStaticPolygon(worldPoly, material, inst.id);
      } else if (shape.kind === 'pointShape') {
        // Soft-body chain. Points are transformed once for both the initial
        // particle position AND the home-anchor target so the prop wants to
        // sit in its placed pose.
        const worldPoints = transformLocal(shape.points, inst);
        const ids: number[] = [];
        for (let i = 0; i < shape.points.length; i++) {
          const sp = shape.points[i];
          const isPinned = sp.pinned === true;
          const mass = isPinned ? 0 : ((sp.mass ?? POINT_SHAPE_DEFAULT_MASS));
          const id = world.addParticle(
            worldPoints[i],
            vec2(0, 0),
            mass,
            POINT_SHAPE_PARTICLE_RADIUS,
          );
          ids.push(id);
          if (!isPinned) {
            world.addHomeAnchor(id, worldPoints[i], POINT_SHAPE_HOME_K, POINT_SHAPE_HOME_DAMP);
          }
        }
        for (const e of shape.edges) {
          if (e.a === e.b) continue;
          const wa = worldPoints[e.a];
          const wb = worldPoints[e.b];
          if (!wa || !wb) continue;
          const dx = wa.x - wb.x;
          const dy = wa.y - wb.y;
          const rest = Math.sqrt(dx * dx + dy * dy);
          world.addExtraSpring(
            ids[e.a], ids[e.b], rest,
            e.stiffness ?? POINT_SHAPE_DEFAULT_K,
            POINT_SHAPE_DEFAULT_DAMP,
          );
        }
      }
    }
  }

  // Hydrate chains. Each ChainDef resolves both endpoints to particle
  // indices, then calls addRopeChain. Fixed-point endpoints add a new
  // static particle at the world position; blob endpoints reference an
  // existing blob's centroid (NPC / soft platform / point shape).
  const chains: ChainInfo[] = [];
  if (level.chains && level.chains.length > 0) {
    const softPlatformById = new Map(softPlatforms.map(s => [s.id, s] as const));
    const pointShapeById = new Map(pointShapes.map(s => [s.id, s] as const));
    const npcById = new Map<string, SlimeBlob>();
    {
      let i = 0;
      for (const npc of level.npcBlobs) {
        npcById.set(npc.id, npcBlobs[i++]);
      }
    }

    const resolveAnchor = (ref: ChainAnchorRef): number | null => {
      if (ref.kind === 'fixed') {
        // Static particle (mass=0). Radius 5 — used only for chain solver math,
        // chain endpoints don't collide with blobs.
        return world.addParticle(vec2(ref.x, ref.y), vec2(0, 0), 0, 5);
      }
      if (ref.entity === 'npc') {
        const b = npcById.get(ref.id);
        return b ? b.centerIdx : null;
      }
      if (ref.entity === 'softPlatform') {
        const s = softPlatformById.get(ref.id);
        return s ? s.centerIdx : null;
      }
      if (ref.entity === 'pointShape') {
        const s = pointShapeById.get(ref.id);
        return s ? s.centerIdx : null;
      }
      return null;
    };

    for (const def of level.chains) {
      const idxA = resolveAnchor(def.endpointA);
      const idxB = resolveAnchor(def.endpointB);
      if (idxA == null || idxB == null) continue;
      const rope = world.addRopeChain(idxA, idxB, {
        totalLength: def.totalLength,
        maxSegmentLength: def.maxSegmentLength ?? 25,
        segmentMass: def.segmentMass ?? 0.5,
        segmentRadius: def.segmentRadius ?? 10,
        iterations: def.iterations ?? 12,
      });
      chains.push({
        id: def.id,
        particleIndices: [idxA, ...rope.particleIndices, idxB],
        totalLength: def.totalLength,
      });
    }
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
    pointShapes,
    chains,
    triggerShapeIdxToId,
    platformSurfaces,
  };
}

function expandSoftPlatform(
  world: SoftBodyEngine,
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

  const worldOrigin = vec2(def.x, def.y);
  const result = world.addBlobFromHull({
    hullRestLocal: hullLocal,
    centerLocal: { x: 0, y: 0 },
    centerMass: Tuning.CENTER_MASS * PLATFORM_CENTER_MASS_MUL,
    hullMass: Tuning.HULL_MASS * PLATFORM_HULL_MASS_MUL,
    springK: Tuning.SPRING_K * PLATFORM_SPRING_K_MUL * stiffness,
    springDamp: Tuning.SPRING_DAMP * PLATFORM_SPRING_DAMP_MUL,
    radialK: Tuning.RADIAL_K * PLATFORM_RADIAL_K_MUL * stiffness,
    radialDamp: Tuning.RADIAL_DAMP * PLATFORM_RADIAL_DAMP_MUL,
    pressureK: 0.0,                        // platforms don't puff
    shapeMatchK: Tuning.SHAPE_MATCH_K * PLATFORM_SHAPE_MATCH_K_MUL * stiffness
                 * (def.frameLocked ? FRAME_LOCK_SHAPE_MATCH_K_BOOST : 1),
    shapeMatchDamp: Tuning.SHAPE_MATCH_DAMP * PLATFORM_SHAPE_MATCH_DAMP_MUL
                 * (def.frameLocked ? FRAME_LOCK_SHAPE_MATCH_DAMP_BOOST : 1),
    worldOrigin,
    sortKey: `softplat:${def.id}`,
    staticHullIndices: anchorIdxs,
    pinFrame: def.frameLocked === true,
  });

  // `pinned` → per-vertex home-springs back to rest world position. Skips
  // anchored verts (they're already mass=0). Strength scales with stiffness.
  if (def.pinned) {
    const homeK = PINNED_HOME_K * stiffness;
    const homeDamp = PINNED_HOME_DAMP;
    const anchoredSet = new Set(anchorIdxs);
    for (let i = 0; i < hullLocal.length; i++) {
      if (anchoredSet.has(i)) continue;
      const rest = vec2(hullLocal[i].x + worldOrigin.x, hullLocal[i].y + worldOrigin.y);
      world.addHomeAnchor(result.hullIndices[i], rest, homeK, homeDamp);
    }
  }

  // Track static hull particle world-indices for trigger animation.
  const staticParticles = anchorIdxs.map(i => result.hullIndices[i]);
  staticParticleMap.set(def.id, staticParticles);

  return {
    id: def.id,
    blobId: result.blobId,
    centerIdx: result.centerIdx,
    hullIndices: result.hullIndices,
    staticHullIndices: staticParticles,
  };
}

/** Signed area of a 2D polygon. Positive = CCW, negative = CW (screen coords). */
function polygonSignedArea(pts: ReadonlyArray<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return a * 0.5;
}

/** Expand a PointShapeDef into a real soft-body blob. The point ring is
 * treated as a closed hull; CW rings are reversed to CCW. Anchored points
 * become static hull particles (mass=0). Returns null if the ring is
 * degenerate (<3 points or zero area). */
function expandPointShapeAsBlob(
  world: SoftBodyEngine,
  def: PointShapeDef,
): PointShapeInfo | null {
  if (def.points.length < 3) return null;

  // Compute centroid (arithmetic mean of the placed points is good enough
  // for the rest-shape origin; addBlobFromHull doesn't require the centroid
  // to be the polygon's barycenter).
  let cx = 0;
  let cy = 0;
  for (const p of def.points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= def.points.length;
  cy /= def.points.length;

  // Hull in local space, indexed CCW. The PointShapeDef order may be CW
  // (it follows the user's click order in the editor); flip if needed so
  // signedAreaPolygon inside the engine reports a positive rest area.
  let hullLocal = def.points.map(p => ({ x: p.x - cx, y: p.y - cy }));
  let anchoredFlags = def.points.map(p => p.anchored);
  if (polygonSignedArea(hullLocal) < 0) {
    hullLocal = hullLocal.slice().reverse();
    anchoredFlags = anchoredFlags.slice().reverse();
  }
  if (hullLocal.length < 3) return null;

  const staticHullIndices: number[] = [];
  for (let i = 0; i < anchoredFlags.length; i++) {
    if (anchoredFlags[i]) staticHullIndices.push(i);
  }

  const stiffness = def.stiffness ?? 1.0;

  const worldOrigin = vec2(cx, cy);
  const result = world.addBlobFromHull({
    hullRestLocal: hullLocal,
    centerLocal: { x: 0, y: 0 },
    centerMass: Tuning.CENTER_MASS * PLATFORM_CENTER_MASS_MUL,
    hullMass: Tuning.HULL_MASS * PLATFORM_HULL_MASS_MUL,
    springK: Tuning.SPRING_K * PLATFORM_SPRING_K_MUL * stiffness,
    springDamp: Tuning.SPRING_DAMP * PLATFORM_SPRING_DAMP_MUL,
    radialK: Tuning.RADIAL_K * PLATFORM_RADIAL_K_MUL * stiffness,
    radialDamp: Tuning.RADIAL_DAMP * PLATFORM_RADIAL_DAMP_MUL,
    pressureK: 0.0,
    shapeMatchK: Tuning.SHAPE_MATCH_K * PLATFORM_SHAPE_MATCH_K_MUL * stiffness
                 * (def.frameLocked ? FRAME_LOCK_SHAPE_MATCH_K_BOOST : 1),
    shapeMatchDamp: Tuning.SHAPE_MATCH_DAMP * PLATFORM_SHAPE_MATCH_DAMP_MUL
                 * (def.frameLocked ? FRAME_LOCK_SHAPE_MATCH_DAMP_BOOST : 1),
    worldOrigin,
    sortKey: `pointshape:${def.id}`,
    staticHullIndices,
    pinFrame: def.frameLocked === true,
  });

  // `pinned` → per-vertex home-springs back to rest world position.
  if (def.pinned) {
    const homeK = PINNED_HOME_K * stiffness;
    const homeDamp = PINNED_HOME_DAMP;
    const anchoredSet = new Set(staticHullIndices);
    for (let i = 0; i < hullLocal.length; i++) {
      if (anchoredSet.has(i)) continue;
      const rest = vec2(hullLocal[i].x + worldOrigin.x, hullLocal[i].y + worldOrigin.y);
      world.addHomeAnchor(result.hullIndices[i], rest, homeK, homeDamp);
    }
  }

  return {
    id: def.id,
    blobId: result.blobId,
    centerIdx: result.centerIdx,
    hullIndices: result.hullIndices,
    staticHullIndices: staticHullIndices.map(i => result.hullIndices[i]),
  };
}
