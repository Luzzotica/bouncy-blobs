import { PlatformDef } from '../levels/types';
import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { StaticSurface } from '../physics/types';
import { vec2 } from '../physics/vec2';

/** Standard ray-cast point-in-polygon for closed polygons. */
function pointInPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = (yi > p.y) !== (yj > p.y) &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

interface MovablePlatform {
  def: PlatformDef;
  surface: StaticSurface;
  /** Polygon at the platform's closed (initial) pose, frozen at init. */
  basePoly: { x: number; y: number }[];
  /** Closed-pose rectangle in LOCAL coords (centred on origin, unrotated).
   *  Used by setPose to rebuild the world poly under any (x, y, rotation),
   *  including actions that rotate the platform around its pivot. */
  localPoly: { x: number; y: number }[];
  /** Closed pose pivot, frozen at init. */
  baseX: number;
  baseY: number;
  /** Closed-pose rotation (radians), frozen at init. */
  baseRotation: number;
  /** Last frame's offset from (baseX, baseY). Used for finite-difference velocity. */
  lastOffsetX: number;
  lastOffsetY: number;
  /** Last frame's absolute rotation — used so getLivePoly stays in sync. */
  lastRotation: number;
}

/**
 * Drives platform geometry from a target (x, y) supplied by `ActionManager`.
 * Mirrors `SpringPadManager`'s pattern: mutate the registered StaticSurface's
 * polygon each frame and set its kinematic velocity so blobs riding the
 * platform get carried during the world step.
 */
export class PlatformMover {
  private platforms = new Map<string, MovablePlatform>();
  private engine: SoftBodyEngine | null = null;

  initialize(defs: PlatformDef[], surfaces: Map<string, StaticSurface>, engine: SoftBodyEngine | null = null): void {
    this.platforms.clear();
    this.engine = engine;
    for (const def of defs) {
      const surface = surfaces.get(def.id);
      if (!surface) continue; // Platform not registered as a static (rare; defensive).
      const basePoly = surface.poly.map(p => ({ x: p.x, y: p.y }));
      // Local poly is the platform's rectangle centred on origin, unrotated.
      // setPose rotates + translates this each frame so rotation works
      // even when the closed-pose rotation is non-zero.
      const hw = def.width / 2;
      const hh = def.height / 2;
      const localPoly = [
        { x: -hw, y: -hh },
        { x:  hw, y: -hh },
        { x:  hw, y:  hh },
        { x: -hw, y:  hh },
      ];
      // Ensure velocity slot exists so we can mutate it each frame.
      if (!surface.velocity) surface.velocity = vec2(0, 0);
      this.platforms.set(def.id, {
        def,
        surface,
        basePoly,
        localPoly,
        baseX: def.x,
        baseY: def.y,
        baseRotation: def.rotation ?? 0,
        lastOffsetX: 0,
        lastOffsetY: 0,
        lastRotation: def.rotation ?? 0,
      });
    }
  }

  /** Closed-pose centre for the named platform, used by ActionManager to snapshot
   *  the "closed" position of platform targets at init time. */
  getBasePosition(platformId: string): { x: number; y: number } | null {
    const p = this.platforms.get(platformId);
    if (!p) return null;
    return { x: p.baseX, y: p.baseY };
  }

  /** Everything the engine-side action loader needs to bind a platform target:
   *  the static-surface wasm index, the closed pose, and the local (centred,
   *  unrotated) rectangle the engine rebuilds the world poly from each tick.
   *  Null if the platform isn't registered or the engine doesn't know it. */
  getPlatformActionData(platformId: string): { staticIdx: number; baseX: number; baseY: number; baseRot: number; localPoly: number[] } | null {
    const p = this.platforms.get(platformId);
    if (!p || !this.engine) return null;
    const staticIdx = this.engine.staticSurfaceIndex(p.surface);
    if (staticIdx < 0) return null;
    const localPoly: number[] = [];
    for (const v of p.localPoly) { localPoly.push(v.x, v.y); }
    return { staticIdx, baseX: p.baseX, baseY: p.baseY, baseRot: p.baseRotation, localPoly };
  }

  /** Move the platform to (x, y) while keeping its closed-pose rotation.
   *  Back-compat shim around setPose for callers that don't animate rotation. */
  setPlatformPos(platformId: string, x: number, y: number, dt: number): void {
    const p = this.platforms.get(platformId);
    if (!p) return;
    this.setPose(platformId, x, y, p.baseRotation, dt);
  }

  /** Set the platform's full pose (x, y, rotation) for this frame. Rebuilds
   *  the world poly from `localPoly` under the new transform. Velocity is
   *  derived from the per-frame translation delta only — rotation doesn't
   *  contribute to the kinematic-carry velocity (matches the prior
   *  translation-only behaviour for blobs sitting on platforms). */
  setPose(platformId: string, x: number, y: number, rotation: number, dt: number): void {
    const p = this.platforms.get(platformId);
    if (!p) return;
    const offsetX = x - p.baseX;
    const offsetY = y - p.baseY;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    for (let i = 0; i < p.localPoly.length; i++) {
      const lx = p.localPoly[i].x;
      const ly = p.localPoly[i].y;
      p.surface.poly[i].x = x + lx * cos - ly * sin;
      p.surface.poly[i].y = y + lx * sin + ly * cos;
    }
    if (p.surface.velocity) {
      const safeDt = Math.max(1e-4, dt);
      p.surface.velocity.x = (offsetX - p.lastOffsetX) / safeDt;
      p.surface.velocity.y = (offsetY - p.lastOffsetY) / safeDt;
    }
    p.lastOffsetX = offsetX;
    p.lastOffsetY = offsetY;
    p.lastRotation = rotation;
    this.engine?.commitStaticSurface(p.surface);
  }

  /** Closed-pose rotation (radians) — used by ActionManager to fill in the
   *  start rotation when a target opts into rotation animation. */
  getBaseRotation(platformId: string): number | null {
    const p = this.platforms.get(platformId);
    if (!p) return null;
    return p.baseRotation;
  }

  /** Live (x, y) for a platform — centroid of the engine's live poly (the
   *  engine now drives platform motion via actions, so the TS surface object is
   *  stale; read the engine snapshot instead). */
  getLivePosition(platformId: string): { x: number; y: number } | null {
    const poly = this.getLivePoly(platformId);
    if (!poly || poly.length === 0) return null;
    let sx = 0, sy = 0;
    for (const v of poly) { sx += v.x; sy += v.y; }
    return { x: sx / poly.length, y: sy / poly.length };
  }

  /** Live world polygon for the named platform — read from the engine's static
   *  surface (the action system mutates the engine-side poly each tick). Used
   *  by the decal renderer to clip splats so they follow the platform. */
  getLivePoly(platformId: string): { x: number; y: number }[] | null {
    const p = this.platforms.get(platformId);
    if (!p || !this.engine) return p?.surface.poly ?? null;
    const idx = this.engine.staticSurfaceIndex(p.surface);
    if (idx < 0) return p.surface.poly;
    return this.engine.staticSurfaces[idx]?.poly ?? p.surface.poly;
  }

  /** Find the platform underneath / closest to `point`. Used when emitting
   *  a splat so it attaches to the platform it landed on and follows it.
   *
   *  Robust to collision-margin offset: the physics engine pushes contact
   *  points OUTSIDE the surface by `collisionMargin`, so a blob landing
   *  on top of a platform reports a contact point several pixels above
   *  the platform's top edge. We check point-in-polygon first (catches
   *  contacts that landed inside the surface, which is rare but valid),
   *  then fall back to nearest-edge distance with generous slack. */
  findPlatformIdAtPoint(point: { x: number; y: number }, maxDist = 28): string | null {
    let bestId: string | null = null;
    let bestDist = maxDist;
    for (const [id, p] of this.platforms) {
      const poly = p.surface.poly;
      if (poly.length < 2) continue;
      if (pointInPolygon(point, poly)) return id;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const len2 = ex * ex + ey * ey;
        let t = 0;
        if (len2 > 0) {
          t = ((point.x - a.x) * ex + (point.y - a.y) * ey) / len2;
          if (t < 0) t = 0; else if (t > 1) t = 1;
        }
        const cx = a.x + ex * t;
        const cy = a.y + ey * t;
        const d = Math.hypot(point.x - cx, point.y - cy);
        if (d < bestDist) { bestDist = d; bestId = id; }
      }
    }
    return bestId;
  }

  cleanup(): void {
    this.platforms.clear();
  }

  /** Rollback snapshot — per-platform offset history. The actual platform
   *  poly is part of the engine snapshot (static_surfaces), so we only
   *  need the JS-side bookkeeping here (last offsets for kinematic-vel
   *  finite differencing). */
  dumpState(): Record<string, { lastOffsetX: number; lastOffsetY: number }> {
    const out: Record<string, { lastOffsetX: number; lastOffsetY: number }> = {};
    for (const [id, p] of this.platforms) {
      out[id] = { lastOffsetX: p.lastOffsetX, lastOffsetY: p.lastOffsetY };
    }
    return out;
  }

  restoreState(state: Record<string, { lastOffsetX: number; lastOffsetY: number }>): void {
    for (const [id, v] of Object.entries(state)) {
      const p = this.platforms.get(id);
      if (!p) continue;
      p.lastOffsetX = v.lastOffsetX;
      p.lastOffsetY = v.lastOffsetY;
    }
  }
}
