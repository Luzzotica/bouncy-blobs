import { PlatformDef } from '../levels/types';
import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { StaticSurface } from '../physics/types';
import { vec2 } from '../physics/vec2';

interface MovablePlatform {
  def: PlatformDef;
  surface: StaticSurface;
  /** Polygon at the platform's closed (initial) pose, frozen at init. */
  basePoly: { x: number; y: number }[];
  /** Closed pose pivot, frozen at init. */
  baseX: number;
  baseY: number;
  /** Last frame's offset from (baseX, baseY). Used for finite-difference velocity. */
  lastOffsetX: number;
  lastOffsetY: number;
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
      // Ensure velocity slot exists so we can mutate it each frame.
      if (!surface.velocity) surface.velocity = vec2(0, 0);
      this.platforms.set(def.id, {
        def,
        surface,
        basePoly,
        baseX: def.x,
        baseY: def.y,
        lastOffsetX: 0,
        lastOffsetY: 0,
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

  /** Move the platform to (x, y). Velocity is derived from the per-frame offset
   *  delta so blobs in contact get the kinematic carry term. `dt` must be > 0. */
  setPlatformPos(platformId: string, x: number, y: number, dt: number): void {
    const p = this.platforms.get(platformId);
    if (!p) return;
    const offsetX = x - p.baseX;
    const offsetY = y - p.baseY;
    for (let i = 0; i < p.basePoly.length; i++) {
      p.surface.poly[i].x = p.basePoly[i].x + offsetX;
      p.surface.poly[i].y = p.basePoly[i].y + offsetY;
    }
    if (p.surface.velocity) {
      const safeDt = Math.max(1e-4, dt);
      p.surface.velocity.x = (offsetX - p.lastOffsetX) / safeDt;
      p.surface.velocity.y = (offsetY - p.lastOffsetY) / safeDt;
    }
    p.lastOffsetX = offsetX;
    p.lastOffsetY = offsetY;
    // Push the mutated poly + velocity into the engine (no-op on the
    // TS sim — its surface object IS the engine's copy).
    this.engine?.commitStaticSurface(p.surface);
  }

  /** Live (x, y) for a platform — used by the renderer so visuals follow physics. */
  getLivePosition(platformId: string): { x: number; y: number } | null {
    const p = this.platforms.get(platformId);
    if (!p) return null;
    return { x: p.baseX + p.lastOffsetX, y: p.baseY + p.lastOffsetY };
  }

  cleanup(): void {
    this.platforms.clear();
  }
}
