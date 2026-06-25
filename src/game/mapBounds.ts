import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import type { LevelData } from '../levels/types';
import type { Vec2 } from '../physics/vec2';

export interface MapAABB { minX: number; minY: number; maxX: number; maxY: number }

/** How far below the lowest map geometry the fall-off-the-map kill plane sits.
 *  Single source of truth for the kill logic (setKillBelowY) AND the lava
 *  surface drawn at that same Y in both the game and the editor. */
export const FALL_KILL_MARGIN = 100;

/** The Y at which to DRAW the lava, or undefined when this level has the lava
 *  visual disabled (`showLava === false`). The kill plane is always active —
 *  this only gates the cosmetic lava. */
export function lavaKillPlaneY(level: LevelData, mapBounds: MapAABB): number | undefined {
  if (level.showLava === false) return undefined;
  return mapBounds.maxY + FALL_KILL_MARGIN;
}

/** When the whole map fits on screen at a zoom >= this, the camera stops
 *  following anyone and just sits and watches the entire arena (KOTH-style).
 *  Tuned so compact arenas (~3200×2400) go static while long race levels
 *  (~8000-wide) keep following. Lowered from 0.3 to 0.25 (÷1.2) in step with
 *  the camera's zoom-out floor so ~20% larger arenas still get the whole-map
 *  view. */
export const STATIC_MAP_FIT_ZOOM = 0.25;

/** `?staticCam=1` forces the static whole-map view on regardless of map size,
 *  `?staticCam=0` forces the classic follow camera. Absent → auto by size. */
export function readStaticCamOverride(): boolean | null {
  if (typeof window === 'undefined' || !window.location) return null;
  try {
    const v = new URLSearchParams(window.location.search).get('staticCam');
    return v === '1' ? true : v === '0' ? false : null;
  } catch { return null; }
}

/** World-space AABB of the actual map geometry — every platform polygon, wall
 *  vertex, soft-body hull point and spawn point. This is the *real* extent the
 *  camera frames (the declared `level.bounds` is only a fallback when a level
 *  has no geometry). Computed once at load from the static rest positions. */
export function computeMapAABB(
  world: SoftBodyEngine,
  level: LevelData,
  platformSurfaces: Map<string, { poly: Vec2[] }>,
  softPlatforms: Array<{ hullIndices: number[]; staticHullIndices: number[] }>,
  pointShapes: Array<{ hullIndices: number[] }>,
  spawnPoints: Vec2[],
): MapAABB {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  const accHull = (idxs: number[]) => {
    for (const i of idxs) {
      const p = world.pos[i];
      if (p) acc(p.x, p.y);
    }
  };
  for (const surface of platformSurfaces.values()) for (const v of surface.poly) acc(v.x, v.y);
  for (const wall of level.walls ?? []) for (const p of wall.points) acc(p.x, p.y);
  for (const sp of softPlatforms) { accHull(sp.hullIndices); accHull(sp.staticHullIndices); }
  for (const ps of pointShapes) accHull(ps.hullIndices);
  for (const s of spawnPoints) acc(s.x, s.y);

  if (!Number.isFinite(minX)) {
    // No geometry at all — fall back to the declared bounds.
    return { minX: 0, minY: 0, maxX: level.bounds.width, maxY: level.bounds.height };
  }
  return { minX, minY, maxX, maxY };
}

/** AABB of a level's geometry computed purely from its LevelData defs — no
 *  physics world required. Used by the editor (which has no engine) to draw the
 *  death-zone lava at the same Y the game kills at. Matches computeMapAABB for
 *  typical levels; rotated platforms use exact corners, but soft bodies that
 *  drift from their rest rect at runtime can differ slightly in-game. */
export function computeLevelAABB(level: LevelData): MapAABB {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  // Accumulate the 4 corners of a (possibly rotated) centre-anchored rect.
  const accRect = (cx: number, cy: number, w: number, h: number, rot = 0) => {
    const hw = w / 2, hh = h / 2;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    for (const [lx, ly] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const) {
      acc(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
    }
  };
  for (const p of level.platforms) accRect(p.x, p.y, p.width, p.height, p.rotation);
  for (const wall of level.walls ?? []) for (const pt of wall.points) acc(pt.x, pt.y);
  for (const sp of level.softPlatforms ?? []) accRect(sp.x, sp.y, sp.width, sp.height, sp.rotation ?? 0);
  for (const ps of level.pointShapes ?? []) for (const pt of ps.points) acc(pt.x, pt.y);
  for (const s of level.spawnPoints) acc(s.x, s.y);

  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: level.bounds.width, maxY: level.bounds.height };
  }
  return { minX, minY, maxX, maxY };
}
