import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { Vec2, vec2 } from '../physics/vec2';
import { StaticSurface } from '../physics/types';
import { SpringPadDef } from '../levels/types';
import { drawSpring } from './springRenderer';

/** Plate thickness along the launch axis, in world units. Thicker = harder
 * to glitch through during a high-speed fire. Keep in sync with the visual
 * `PLATE_THICKNESS` in springRenderer.ts. */
const PLATE_THICKNESS = 72;
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

/** Deterministic FNV-1a hash of a string → u32. Used to derive a
 *  stable numeric id for the engine from the gameplay string id, so
 *  both host and guest map the same def.id → same engine slot. */
function hashStringId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

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
    world.clearSpringPads();
    for (const def of defs) this.springs.push(this.registerPlate(world, def));
  }

  /** Add a spring pad at runtime (for party mode placement). */
  addSpring(def: SpringPadDef): void {
    if (!this.world) return;
    this.springs.push(this.registerPlate(this.world, def));
  }

  private registerPlate(world: SoftBodyEngine, def: SpringPadDef): RegisteredSpring {
    // Phase 5 migration: state machine + kinematic plate pose now live
    // in the Rust engine. JS keeps a shadow record for renderer access
    // to def + offset, but doesn't run the state machine itself.
    const cos = Math.cos(def.rotation);
    const sin = Math.sin(def.rotation);
    const launchDir = vec2(cos, sin);
    const perpDir = vec2(-sin, cos);
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
    const rawFire = def.fireSpeed ?? DEFAULT_FIRE_SPEED;
    const fireSpeed = Math.min(MAX_FIRE_SPEED, Math.max(MIN_FIRE_SPEED, rawFire));

    // Numeric id for engine — use a hash of the string id for stable
    // cross-side mapping (both host + guest derive the same number from
    // the same def.id).
    const numericId = hashStringId(def.id);
    world.addSpringPad(numericId, def.x, def.y, def.width, def.height, def.rotation, fireSpeed);

    // The engine creates its own static surface; we don't have a
    // handle to it for the legacy `s.surface` field, so we leave that
    // as a placeholder. JS callers that reach into s.surface (only the
    // renderer + the old update path) get the now-unused initial
    // cocked-pose poly. The engine writes the live poly via
    // update_spring_pads internally.
    const placeholderSurface = {
      poly: basePoly.map((p) => vec2(p.x - launchDir.x * initialOffset, p.y - launchDir.y * initialOffset)),
      material: 'default' as const,
      id: `spring:${def.id}`,
      velocity: vec2(0, 0),
      layer: 0xFFFFFFFF,
      mask: 0xFFFFFFFF,
    } as unknown as StaticSurface;

    return {
      def, launchDir, perpDir, basePoly, surface: placeholderSurface,
      state: 'loaded',
      offset: initialOffset,
      maxCompress,
      reloadSpeed: maxCompress / RELOAD_TIME,
      cooldown: 0,
      fireSpeed,
    };
  }

  update(_dt: number): void {
    if (!this.world) return;
    const world = this.world;
    // Phase 5: state machines + plate kinematics live in the Rust
    // engine (called from world.step). JS reads engine state for
    // rendering + drains fire events for VFX/SFX.
    const stateMap = ['loaded', 'firing', 'reloading'] as const;
    for (let i = 0; i < this.springs.length; i++) {
      const s = this.springs[i];
      s.state = stateMap[world.springPadState(i)] ?? 'loaded';
      s.offset = world.springPadOffset(i);
    }
    // Drain fire events for VFX/SFX. Engine returns the gameplay
    // numeric IDs (FNV-1a of the def.id string).
    const fired = world.takeSpringPadFireEvents();
    if (this.onFire && fired.length > 0) {
      for (const fid of fired) {
        const idx = this.springs.findIndex((s) => hashStringId(s.def.id) === fid);
        if (idx >= 0) {
          const s = this.springs[idx];
          this.onFire(vec2(s.def.x, s.def.y), s.launchDir);
        }
      }
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

  /** Spring id whose plate front face is near `point`, or null. Lets the decal
   *  system attach splats to a spring so they ride the plate as it moves —
   *  mirrors PlatformMover.findPlatformIdAtPoint. */
  findSpringIdAtPoint(point: { x: number; y: number }, maxDist = 28): string | null {
    for (const s of this.springs) {
      const { def, launchDir, perpDir, offset } = s;
      const hw = def.width / 2;
      const hh = (def.height * PLATE_WIDTH_SCALE) / 2;
      const frontLocalX = hw - offset; // plate retracts along launchDir by offset
      const rx = point.x - def.x;
      const ry = point.y - def.y;
      const localX = launchDir.x * rx + launchDir.y * ry;
      const localY = perpDir.x * rx + perpDir.y * ry;
      if (Math.abs(localY) > hh + maxDist) continue;
      const dx = localX - frontLocalX;
      if (dx >= -(PLATE_THICKNESS + maxDist) && dx <= maxDist) return s.def.id;
    }
    return null;
  }

  /** Live reference point that translates with a spring's plate: the def origin
   *  retracted along the launch direction by the current offset (the same
   *  transform the plate corners use). A splat stores its position relative to
   *  this, so it rides the plate as it compresses/fires. */
  getSpringLivePosition(springId: string): { x: number; y: number } | null {
    const s = this.springs.find((sp) => sp.def.id === springId);
    if (!s) return null;
    return { x: s.def.x - s.launchDir.x * s.offset, y: s.def.y - s.launchDir.y * s.offset };
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
