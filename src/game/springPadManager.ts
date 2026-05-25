import { SoftBodyWorld } from '../physics/softBodyWorld';
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import { Vec2, vec2 } from '../physics/vec2';
import { StaticSurface } from '../physics/types';
import { SpringPadDef } from '../levels/types';
import { drawSpring } from './springRenderer';

/** Plate thickness along the launch axis, in world units. */
const PLATE_THICKNESS = 36;
/** Multiplier applied to `def.height` to get the plate's perpendicular width. */
const PLATE_WIDTH_SCALE = 8;
/** How far the plate retracts when cocked, as a fraction of def.width. */
const MAX_COMPRESS_FRAC = 0.7;
/** Default extension speed when a SpringPadDef omits `fireSpeed`. */
const DEFAULT_FIRE_SPEED = 1100;
/** Clamp range for authored `fireSpeed` values. */
const MIN_FIRE_SPEED = 500;
const MAX_FIRE_SPEED = 2500;
/** Duration of the slow retract back to the cocked position. */
const RELOAD_TIME = 0.45;
/** Minimum gap between fires after a launch starts. */
const COOLDOWN_TIME = 0.05;
/** Detection band in front of the plate's face. Generous on the +launchDir side so a
 * resting blob (which sits ~`staticContactSlop` units above the surface after collision
 * resolution) still trips the trigger. */
const TRIGGER_FORWARD = 22;
const TRIGGER_BACKWARD = 4;
/** Perpendicular tolerance past the plate's edge — blobs grazing the corner still count. */
const TRIGGER_SIDE_PAD = 4;

type PlateState = 'loaded' | 'firing' | 'reloading';

interface RegisteredSpring {
  def: SpringPadDef;
  launchDir: Vec2;
  perpDir: Vec2;
  /** Plate's polygon in WORLD space at offset = 0 (fully extended). */
  basePoly: Vec2[];
  /** Live surface registered with the physics world. We mutate its .poly and .velocity each frame. */
  surface: StaticSurface;
  state: PlateState;
  /** Retraction along -launchDir. 0 = fully extended (front face at +width/2 in plate-local frame). */
  offset: number;
  maxCompress: number;
  reloadSpeed: number;
  cooldown: number;
  /** Resolved launch speed for this plate (def.fireSpeed clamped, or default). */
  fireSpeed: number;
}

export class SpringPadManager {
  private springs: RegisteredSpring[] = [];
  private world: SoftBodyEngine | null = null;
  /** Fired when a plate transitions loaded → firing. Receives plate centre
   * and unit launch direction (so callers can spawn directional VFX). */
  onFire?: (position: Vec2, launchDir: Vec2) => void;

  initialize(world: SoftBodyEngine, defs: SpringPadDef[]): void {
    this.world = world;
    this.springs = [];
    for (const def of defs) this.springs.push(this.registerPlate(world, def));
  }

  /** Add a spring pad at runtime (for party mode placement). */
  addSpring(def: SpringPadDef): void {
    if (!this.world) return;
    this.springs.push(this.registerPlate(this.world, def));
  }

  private registerPlate(world: SoftBodyEngine, def: SpringPadDef): RegisteredSpring {
    const cos = Math.cos(def.rotation);
    const sin = Math.sin(def.rotation);
    const launchDir = vec2(cos, sin);
    const perpDir = vec2(-sin, cos);

    // Plate-local rectangle (extended pose): x ∈ [w/2 - thickness, w/2], y ∈ [-h/2, h/2]
    const hw = def.width / 2;
    const hh = (def.height * PLATE_WIDTH_SCALE) / 2;
    const frontX = hw;
    const backX = hw - PLATE_THICKNESS;
    const localCorners: Vec2[] = [
      vec2(backX, -hh),
      vec2(frontX, -hh),
      vec2(frontX,  hh),
      vec2(backX,  hh),
    ];
    const basePoly: Vec2[] = localCorners.map(c => vec2(
      def.x + cos * c.x - sin * c.y,
      def.y + sin * c.x + cos * c.y,
    ));

    const maxCompress = def.width * MAX_COMPRESS_FRAC;
    const initialOffset = maxCompress;
    const surface = world.registerStaticPolygon(basePoly, 'default', `spring:${def.id}`);
    // Shift to initial (cocked) position.
    for (let i = 0; i < surface.poly.length; i++) {
      surface.poly[i].x = basePoly[i].x - launchDir.x * initialOffset;
      surface.poly[i].y = basePoly[i].y - launchDir.y * initialOffset;
    }
    surface.velocity = vec2(0, 0);
    world.commitStaticSurface(surface);

    const rawFire = def.fireSpeed ?? DEFAULT_FIRE_SPEED;
    const fireSpeed = Math.min(MAX_FIRE_SPEED, Math.max(MIN_FIRE_SPEED, rawFire));

    return {
      def, launchDir, perpDir, basePoly, surface,
      state: 'loaded',
      offset: initialOffset,
      maxCompress,
      reloadSpeed: maxCompress / RELOAD_TIME,
      cooldown: 0,
      fireSpeed,
    };
  }

  update(dt: number): void {
    if (!this.world) return;
    const world = this.world;

    for (const s of this.springs) {
      if (s.cooldown > 0) s.cooldown = Math.max(0, s.cooldown - dt);

      // --- State transitions ---
      if (s.state === 'loaded' && s.cooldown <= 0 && this.frontFaceTouched(s)) {
        s.state = 'firing';
        this.onFire?.(vec2(s.def.x, s.def.y), s.launchDir);
      }

      // --- Drive offset & set surface velocity ---
      let velAlongLaunch = 0; // signed: + = extending outward along launchDir
      if (s.state === 'firing') {
        s.offset -= s.fireSpeed * dt;
        velAlongLaunch = s.fireSpeed;
        if (s.offset <= 0) {
          s.offset = 0;
          s.state = 'reloading';
          s.cooldown = COOLDOWN_TIME;
          velAlongLaunch = 0;
        }
      } else if (s.state === 'reloading') {
        s.offset += s.reloadSpeed * dt;
        velAlongLaunch = -s.reloadSpeed;
        if (s.offset >= s.maxCompress) {
          s.offset = s.maxCompress;
          s.state = 'loaded';
          velAlongLaunch = 0;
        }
      }

      // --- Write live poly + surface velocity ---
      for (let i = 0; i < s.surface.poly.length; i++) {
        s.surface.poly[i].x = s.basePoly[i].x - s.launchDir.x * s.offset;
        s.surface.poly[i].y = s.basePoly[i].y - s.launchDir.y * s.offset;
      }
      s.surface.velocity!.x = s.launchDir.x * velAlongLaunch;
      s.surface.velocity!.y = s.launchDir.y * velAlongLaunch;
      // Push the mutation into the engine (no-op on TS sim).
      world.commitStaticSurface(s.surface);
    }
  }

  /** Returns true if any blob hull particle is within TRIGGER_SLOP of the plate's front face. */
  private frontFaceTouched(s: RegisteredSpring): boolean {
    if (!this.world) return false;
    const world = this.world;
    const { def, launchDir, perpDir, offset } = s;
    const hw = def.width / 2;
    const hh = (def.height * PLATE_WIDTH_SCALE) / 2;
    // Front face is at plate-local x = hw - offset (the plate has been retracted by `offset`).
    const frontLocalX = hw - offset;

    for (let bi = 0; bi < world.blobRanges.length; bi++) {
      const r = world.blobRanges[bi];
      if (r.inactive) continue;
      for (const idx of r.hull) {
        const p = world.pos[idx];
        const rx = p.x - def.x;
        const ry = p.y - def.y;
        const localX = launchDir.x * rx + launchDir.y * ry;   // dot(rel, launchDir)
        const localY = perpDir.x  * rx + perpDir.y  * ry;     // dot(rel, perpDir)
        if (Math.abs(localY) > hh + TRIGGER_SIDE_PAD) continue;
        const dx = localX - frontLocalX;
        if (dx >= -TRIGGER_BACKWARD && dx <= TRIGGER_FORWARD) return true;
      }
    }
    return false;
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const s of this.springs) {
      drawSpring(ctx, s.def, s.offset, s.maxCompress, s.state);
    }
  }

  /** Serializable mutable state. Captures the per-plate state-machine and
   * cooldown/offset values so a network peer can resume from a host's
   * snapshot. Identified by `def.id` (string), which is stable across
   * clients because every client loads the same level data. */
  dumpState(): Record<string, { state: PlateState; offset: number; cooldown: number }> {
    const out: Record<string, { state: PlateState; offset: number; cooldown: number }> = {};
    for (const s of this.springs) {
      out[s.def.id] = { state: s.state, offset: s.offset, cooldown: s.cooldown };
    }
    return out;
  }

  /** Apply a serialized snapshot (typically from a keyframe). Springs not in
   * the snapshot keep their current state — they were either added after
   * the snapshot was taken or removed before; either way the local sim's
   * value is the best guess until the next snapshot. */
  restoreState(state: Record<string, { state: PlateState; offset: number; cooldown: number }>): void {
    for (const s of this.springs) {
      const v = state[s.def.id];
      if (!v) continue;
      s.state = v.state;
      s.offset = v.offset;
      s.cooldown = v.cooldown;
      // Write the surface polygon to match the restored offset so the next
      // physics step sees correct geometry without waiting for update().
      for (let i = 0; i < s.surface.poly.length; i++) {
        s.surface.poly[i].x = s.basePoly[i].x - s.launchDir.x * s.offset;
        s.surface.poly[i].y = s.basePoly[i].y - s.launchDir.y * s.offset;
      }
      this.world?.commitStaticSurface(s.surface);
    }
  }

  cleanup(): void {
    if (this.world) {
      for (const s of this.springs) this.world.removeStaticSurface(s.surface);
    }
    this.springs = [];
    this.world = null;
  }
}
