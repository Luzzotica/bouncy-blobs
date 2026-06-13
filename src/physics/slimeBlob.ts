import { SoftBodyWorld } from './softBodyWorld';
import type { SoftBodyEngine } from "./SoftBodyEngine";
import { Vec2, vec2, ZERO } from './vec2';
import * as Tuning from './tuning';
import * as HullPresets from './hullPresets';
import { BlobResult } from './types';

export type HullPreset = 'circle16' | 'square' | 'triangle' | 'star' | 'diamond' | 'hexagon';

export const BLOB_RADIUS = 48;
export const BLOB_EXPAND_MAX_SCALE = 3.0;
export const BLOB_SQUASH_X_AMOUNT = 0.35;
export const BLOB_SQUASH_Y_AMOUNT = 0.3;
// Forces are now per-second (multiplied by dt in applyBlobMoveForce).
// Old per-frame values (2.0 / 1.5 / 0.8) scaled by 60 to preserve 60fps feel.
const MOVE_FORCE = 240.0;
const AIR_MOVE_MULTIPLIER = 0.3;
const PLAYER_K_MULT = 0.92;
const PLAYER_MASS_MULT = 0.5;
const EXPAND_SPRING_STIFFNESS_MULT = 1.45;

// Joystick shape deformation
// `LEAN_AMOUNT`, `SQUASH_X_AMOUNT`, `SQUASH_Y_AMOUNT` moved into the
// Rust engine (see `set_blob_squash_lean` in `crates/softbody/src/
// world.rs`). They were JS gameplay-tuning constants that fed into
// implementation-defined `Math.cos/sin/atan2` per tick; now the engine
// owns them so the per-tick deformation is deterministic across wasm
// instances. If gameplay wants per-blob tuning later, lift them onto
// the engine's `Shape` and thread through `add_blob_from_hull`.
const LEAN_MAX_SPEED = 3500;   // lateral speed (px/s) at which lean maxes out
const DOWN_FORCE = 180.0;      // downward force (per-second)
const UP_FORCE = 96.0;         // upward force (per-second, gentle float)
// Ledge-hang assist: when an upper-half hull particle is touching geometry
// but no lower-half particle is, the blob is hooked on a ledge. Multiply
// UP_FORCE so it beats gravity (~980/s²) and lets the player clamber up.
const LEDGE_UP_FORCE_MULT = 12.0;
const LEDGE_HANG_MIN_UPPER_CONTACTS = 1;

// Hull "treadmill": circulate the hull-perimeter points along the contour in
// the direction of movement (like a tank tread) whenever steering laterally —
// always, even airborne or riding another blob / softbody platform. Gripped
// contact points push the body the opposite way — that reaction is the clamber
// "pull" (the engine clamps it to a fixed accel ceiling). The rate is CONSTANT
// (not scaled by speed) and deliberately gentle.
const TREAD_RATE = 1500;       // constant tread accel (px/s²)
// ±1 — flips which way hull-ring order maps to "toward movement". Tune by feel.
const TREAD_SIGN = 1;

// Sticky wall stick
const STICK_MIN_CONTACTS = 2;    // hull points touching sticky surface to engage
const STICK_RELEASE_GRACE = 0.25;// seconds — can't re-stick to same wall immediately after release
const STICK_JUMP_IMPULSE = 1400; // instant velocity impulse on release

export interface SlimeBlobConfig {
  playerControlled?: boolean;
  hullPreset?: HullPreset;
  expandShapeScaleMax?: number;
  expandShapeScaleSpeed?: number;
  expandShapeScaleSpeedPress?: number;
  /** Stable cross-client identifier — see `BlobRange.sortKey` and
   * `SoftBodyWorld.addBlobFromHull`'s `sortKey` parameter. Pass the
   * playerId for player blobs, the NPC id for NPCs. Omit for single-
   * player / editor / test contexts where cross-client order doesn't
   * matter. */
  sortKey?: string;
}

function getHullLocal(preset: HullPreset): Vec2[] {
  switch (preset) {
    case 'circle16': return HullPresets.circle(16, BLOB_RADIUS);
    case 'square': return HullPresets.square(BLOB_RADIUS);
    case 'triangle': return HullPresets.triangle(52);
    case 'star': return HullPresets.star(5, 56, 22);
    case 'diamond': return HullPresets.diamond(BLOB_RADIUS);
    case 'hexagon': return HullPresets.hexagon(BLOB_RADIUS);
    default: return HullPresets.circle(16, BLOB_RADIUS);
  }
}

export class SlimeBlob {
  readonly blobId: number;
  readonly hullIndices: number[];
  readonly centerIdx: number;
  readonly shapeIdx: number;
  readonly playerControlled: boolean;

  private world: SoftBodyEngine;
  private expandPressed = false;
  private expandWasPressed = false;
  private stickX = 0;  // raw joystick input (world-space)
  private stickY = 0;
  private expandShapeScale = 1.0;
  /** Per-blob gravity override. null = use world gravity. */
  private gravityOverride: Vec2 | null = null;

  // Sticky wall state
  private stuckTo: { normal: Vec2 } | null = null;
  /** Seconds remaining where re-sticking is suppressed. */
  private stickReleaseGrace = 0;

  private expandShapeScaleMax: number;
  private expandShapeScaleSpeed: number;
  private expandShapeScaleSpeedPress: number;

  // Powerup multipliers
  private moveForceMultiplier = 1.0;
  private expandSpeedMultiplier = 1.0;

  constructor(world: SoftBodyEngine, worldOrigin: Vec2, config: SlimeBlobConfig = {}) {
    this.world = world;
    this.playerControlled = config.playerControlled ?? true;
    this.expandShapeScaleMax = config.expandShapeScaleMax ?? 3.0;
    this.expandShapeScaleSpeed = config.expandShapeScaleSpeed ?? 18.0;
    this.expandShapeScaleSpeedPress = config.expandShapeScaleSpeedPress ?? 36.0;

    const hullPreset = config.hullPreset ?? 'circle16';
    const hullLocal = getHullLocal(hullPreset);
    const pk = this.playerControlled;

    const sk = Tuning.SPRING_K * (pk ? PLAYER_K_MULT : 1);
    const sd = Tuning.SPRING_DAMP;
    // Radial springs (center↔hull) disabled for SlimeBlobs. The center
    // is virtual — pinned to the hull centroid each substep by the
    // engine — so a center↔hull spring's reaction force on the center
    // is dropped by the pin, leaving the hull with an unmatched net
    // impulse. That manifested as the blob "flying away" on expand.
    // Shape-match alone is responsible for blob cohesion now.
    const rk = 0;
    const rd = 0;
    const smk = Tuning.SHAPE_MATCH_K * (pk ? PLAYER_K_MULT : 1);
    const smd = Tuning.SHAPE_MATCH_DAMP;
    const cm = Tuning.CENTER_MASS * (pk ? PLAYER_MASS_MULT : 1);
    const hm = Tuning.HULL_MASS * (pk ? PLAYER_MASS_MULT : 1);

    const result: BlobResult = world.addBlobFromHull({
      hullRestLocal: hullLocal,
      centerLocal: ZERO,
      centerMass: cm,
      hullMass: hm,
      springK: sk,
      springDamp: sd,
      radialK: rk,
      radialDamp: rd,
      pressureK: Tuning.PRESSURE_K,
      shapeMatchK: smk,
      shapeMatchDamp: smd,
      worldOrigin,
      sortKey: config.sortKey,
    });

    this.blobId = result.blobId;
    this.hullIndices = result.hullIndices;
    this.centerIdx = result.centerIdx;
    this.shapeIdx = result.shapeIdx;
  }

  setMoveForceMultiplier(m: number): void {
    this.moveForceMultiplier = m;
  }

  setExpandSpeedMultiplier(m: number): void {
    this.expandSpeedMultiplier = m;
  }

  resetMultipliers(): void {
    this.moveForceMultiplier = 1.0;
    this.expandSpeedMultiplier = 1.0;
  }

  /** Retire this blob from the physics world. Particles/springs/shape stay
   * allocated (indices into world arrays must remain stable for every other
   * blob) but are tagged inactive so no physics pass touches them. */
  destroy(): void {
    this.world.removeBlob(this.blobId);
  }

  setInput(moveX: number, moveY: number, expand: boolean): void {
    this.stickX = Math.max(-1, Math.min(1, moveX));
    this.stickY = Math.max(-1, Math.min(1, moveY));
    this.expandPressed = expand;
  }

  /** True if any of this blob's particles are currently in contact with the ground/platform. */
  isGrounded(): boolean {
    return this.world.getBlobGroundContacts(this.blobId) > 0;
  }

  /** Representative ground-contact point + outward surface normal from the
   * most recent physics step, or null when not grounded. Used by VFX to
   * place splats on the actual surface rather than at the blob's centroid. */
  getGroundContact(): { point: Vec2; normal: Vec2; poly: Vec2[] | null } | null {
    return this.world.getBlobGroundContact(this.blobId);
  }

  /** Representative impact contact on any static surface (floor, wall, or
   * ceiling) from the most recent physics step, or null if not touching
   * anything. Used by VFX to spawn splats on walls/ceilings on hard impact. */
  getImpactContact(): { point: Vec2; normal: Vec2; poly: Vec2[] | null } | null {
    return this.world.getBlobImpactContact(this.blobId);
  }

  setGravityOverride(g: Vec2 | null): void {
    this.gravityOverride = g;
  }

  /** Count contacting hull particles split by whether they sit above or below
   * the hull centroid along the up axis (negated gravity). `upper` contacts
   * mean the gripping surface is above the blob (ledge/roof); `lower` means
   * it's a floor. Pure arithmetic + contact reads → deterministic. */
  private contactSplit(): { upper: number; lower: number } {
    const contacts = this.world.getBlobParticleContacts(this.blobId);
    if (contacts.length === 0) return { upper: 0, lower: 0 };
    const hull = this.world.getHullPolygon(this.blobId);
    if (hull.length !== contacts.length) return { upper: 0, lower: 0 };
    const g = this.getGravityDir();
    const upX = -g.x, upY = -g.y;
    let cx = 0, cy = 0;
    for (let i = 0; i < hull.length; i++) { cx += hull[i].x; cy += hull[i].y; }
    cx /= hull.length; cy /= hull.length;
    let upper = 0, lower = 0;
    for (let i = 0; i < hull.length; i++) {
      if (!contacts[i]) continue;
      const dot = (hull[i].x - cx) * upX + (hull[i].y - cy) * upY;
      if (dot > 0) upper++;
      else if (dot < 0) lower++;
    }
    return { upper, lower };
  }

  /** True when the upper half of the hull (relative to gravity) has at
   * least LEDGE_HANG_MIN_UPPER_CONTACTS particles touching geometry while
   * the lower half has none — the blob is hooked on an edge with its
   * body dangling. Used to amplify UP_FORCE so the player can climb up. */
  private isLedgeHanging(): boolean {
    const { upper, lower } = this.contactSplit();
    return upper >= LEDGE_HANG_MIN_UPPER_CONTACTS && lower === 0;
  }

  /** Get the effective gravity direction (normalized). */
  private getGravityDir(): Vec2 {
    const g = this.gravityOverride ?? this.world.getBlobEffectiveGravity(this.blobId);
    const len = Math.sqrt(g.x * g.x + g.y * g.y);
    if (len < 0.0001) return vec2(0, 1); // fallback to down
    return vec2(g.x / len, g.y / len);
  }

  update(delta: number): void {
    if (!this.playerControlled) return;

    // Rising-edge detection for the jump/release button.
    const jumpPressed = this.expandPressed && !this.expandWasPressed;

    // Decrement release grace timer
    if (this.stickReleaseGrace > 0) {
      this.stickReleaseGrace = Math.max(0, this.stickReleaseGrace - delta);
    }

    // ── Sticky wall state machine ────────────────────────────────────
    const sticky = this.world.getBlobStickyContact(this.blobId);

    // Attempt to enter stuck state
    if (
      this.stuckTo === null &&
      this.stickReleaseGrace === 0 &&
      sticky.count >= STICK_MIN_CONTACTS
    ) {
      this.stuckTo = { normal: sticky.normal };
      this.world.setBlobGravityOverride(this.blobId, vec2(0, 0));
      this.world.zeroBlobVelocity(this.blobId);
      // Pin every particle to its current world position — substeps will keep
      // restoring this snapshot until release, eliminating shape-match drift.
      this.world.pinBlobToCurrentPose(this.blobId);
    }

    // While stuck: handle release; otherwise skip the normal movement code path.
    if (this.stuckTo !== null) {
      // Refresh the wall normal if we still have contact (handles a moving wall)
      if (sticky.count > 0) this.stuckTo.normal = sticky.normal;

      // Compute aim from input: joystick X/Y in world space.
      // If the joystick is pushing into the wall, project onto the wall's tangent plane.
      let aim = vec2(this.stickX, this.stickY);
      const aLen = Math.sqrt(aim.x * aim.x + aim.y * aim.y);
      const n = this.stuckTo.normal;
      if (aLen < 0.1) {
        // No input → default to jumping straight off the wall.
        aim = { x: n.x, y: n.y };
      } else {
        aim = { x: aim.x / aLen, y: aim.y / aLen };
        // Clamp to half-plane facing away from the wall.
        const into = aim.x * n.x + aim.y * n.y;
        if (into < 0) {
          aim = { x: aim.x - n.x * into, y: aim.y - n.y * into };
          const tLen = Math.sqrt(aim.x * aim.x + aim.y * aim.y);
          if (tLen < 0.05) aim = { x: n.x, y: n.y };
          else aim = { x: aim.x / tLen, y: aim.y / tLen };
        }
      }

      if (jumpPressed) {
        // Release: unpin first so the impulse is preserved, then launch.
        this.world.unpinBlob(this.blobId);
        this.world.applyBlobLinearVelocityDelta(
          this.blobId,
          vec2(aim.x * STICK_JUMP_IMPULSE, aim.y * STICK_JUMP_IMPULSE),
        );
        this.stuckTo = null;
        this.stickReleaseGrace = STICK_RELEASE_GRACE;
        this.world.setBlobGravityOverride(this.blobId, null);
      } else {
        // Keep velocity damped while stuck so the high-friction surface can pin us.
        // (Gravity is already overridden to zero.) Cache aim so the renderer can show it.
        (this.stuckTo as { normal: Vec2; aim?: Vec2 }).aim = aim;
        this.world.setBlobShapeMatchRestScale(this.blobId, this.expandShapeScale);
        this.expandWasPressed = this.expandPressed;
        return;
      }
    }

    // ── Normal movement path ─────────────────────────────────────────

    // Spring stiffness while expanding
    const expandSpringMult = this.expandPressed ? EXPAND_SPRING_STIFFNESS_MULT : 1.0;
    this.world.setBlobSpringStiffnessScale(this.blobId, expandSpringMult);

    // Gravity-relative frame, still needed for the up/down stick axis +
    // hull lean. Movement scheme:
    //   - LATERAL (stickX) is WORLD-FIXED: A always = world left, D always
    //     = world right, regardless of gravity orientation. Keeps muscle
    //     memory stable inside gravity zones that flip / tilt gravity.
    //   - DOWN/UP (stickY) stays gravity-relative: push "toward gravity"
    //     to crouch / fall faster, push "against gravity" to float. This
    //     is the "physical" axis — pushing harder into whatever the floor
    //     IS, regardless of orientation.
    //   - JUMP is the soft-body expand, which physically pushes off
    //     whatever surface you're touching — gravity-agnostic by design.
    const down = this.getGravityDir();
    const right = vec2(down.y, -down.x); // perpendicular, gravity-relative (for lean)
    const up = vec2(-down.x, -down.y);

    // Lateral movement — world-fixed X. Reduced in air.
    const grounded = this.world.getBlobGroundContacts(this.blobId) > 0;
    const airMult = grounded ? 1.0 : AIR_MOVE_MULTIPLIER;
    const lateralDir = vec2(this.stickX, 0);
    this.world.applyBlobMoveForce(this.blobId, lateralDir, MOVE_FORCE * this.moveForceMultiplier * airMult, delta);

    // Gravity-axis forces from joystick Y — still gravity-relative so
    // "push down" always means "press into whatever the floor is".
    if (this.stickY > 0.1) {
      this.world.applyBlobMoveForce(this.blobId, down, DOWN_FORCE * this.stickY * this.moveForceMultiplier, delta);
    } else if (this.stickY < -0.1) {
      const upMult = this.isLedgeHanging() ? LEDGE_UP_FORCE_MULT : 1.0;
      this.world.applyBlobMoveForce(this.blobId, up, UP_FORCE * upMult * -this.stickY * this.moveForceMultiplier, delta);
    }

    // Hull treadmill — run the perimeter points along the contour toward the
    // movement direction whenever steering laterally, at a constant gentle
    // rate, ALWAYS (even airborne or riding another blob / softbody platform;
    // grounding isn't required — the engine's contact bitmap drives the clamber
    // pull wherever the hull actually grips). If the gripping surface is ABOVE
    // the blob (hanging on a ledge / under a roof), invert so it still pulls us
    // up and over the lip.
    //
    // Determinism: the strength uses only snapshotted signals (ground/impact
    // contact NORMAL); the engine reads the snapshotted per-particle contact
    // bitmap for the body reaction.
    if (Math.abs(this.stickX) > 0.1) {
      let strength = TREAD_RATE * Math.sign(this.stickX) * TREAD_SIGN;
      // Surface above ⟺ its outward normal points back along "up" (downward
      // toward the blob). Use ground normal first, else the impact normal.
      const n = this.getGroundContact()?.normal ?? this.getImpactContact()?.normal ?? null;
      if (n && (n.x * up.x + n.y * up.y) < 0) strength = -strength;
      this.world.setBlobTread(this.blobId, strength);
    }

    // Hull shape deformation from velocity + input (gravity-relative)
    this.updateHullDeformation(down, right);

    // Expand shape scale animation
    const targetShapeScale = this.expandPressed ? this.expandShapeScaleMax : 1.0;
    const baseRate = targetShapeScale > this.expandShapeScale
      ? this.expandShapeScaleSpeedPress
      : this.expandShapeScaleSpeed;
    const rampRate = baseRate * this.expandSpeedMultiplier;
    this.expandShapeScale = moveToward(this.expandShapeScale, targetShapeScale, rampRate * delta);
    this.world.setBlobShapeMatchRestScale(this.blobId, this.expandShapeScale);

    this.expandWasPressed = this.expandPressed;
  }

  /** While stuck to a sticky surface, returns the current aim direction + wall normal
   * for rendering an aim indicator. Returns null when not stuck. */
  getStickAim(): { aim: Vec2; normal: Vec2 } | null {
    if (this.stuckTo === null) return null;
    const aim = (this.stuckTo as { normal: Vec2; aim?: Vec2 }).aim ?? this.stuckTo.normal;
    return { aim, normal: this.stuckTo.normal };
  }

  /** Get average blob velocity projected onto a given axis. */
  private getHullVelocityAlong(axis: Vec2): number {
    const vel = this.world.getVelocities();
    let sum = 0;
    for (const idx of this.hullIndices) {
      sum += vel[idx].x * axis.x + vel[idx].y * axis.y;
    }
    return sum / this.hullIndices.length;
  }

  private updateHullDeformation(down: Vec2, right: Vec2): void {
    // ── Scalar inputs computed in JS ───────────────────────────────
    // These are pure arithmetic (max/min/divide) on velocity & input —
    // bit-deterministic in IEEE 754, so we can compute them on the JS
    // side and let the engine quantize them once at the wasm boundary.
    const vLateral = this.getHullVelocityAlong(right);
    const lean = Math.max(-1, Math.min(1, vLateral / LEAN_MAX_SPEED));
    const squash = Math.max(0, this.stickY);

    // ── The trig + per-particle deformation lives in Rust now ──────
    // The JS version of this used `Math.atan2/cos/sin` to compute the
    // blob's rotation and rotate `down` into the blob-local frame.
    // Those transcendentals are implementation-defined per ECMA and
    // could return last-bit-different f64 values across two V8
    // instances on the same machine, which then quantized into
    // different `Fx` rest-hull poses and made the shape-match
    // constraint pull differently each tick. The engine now does the
    // whole thing in i64 fixed-point via `sin_fx/cos_fx/atan2_fx`
    // (LUT-based, bit-identical across every wasm instance).
    this.world.setBlobSquashLean(this.blobId, squash, lean, down);
  }


  getCenterPosition(): Vec2 {
    const positions = this.world.getPositions();
    const p = positions[this.centerIdx];
    return vec2(p.x, p.y);
  }

  getCentroid(): Vec2 {
    const positions = this.world.getPositions();
    let cx = 0, cy = 0;
    for (const idx of this.hullIndices) {
      cx += positions[idx].x;
      cy += positions[idx].y;
    }
    const n = this.hullIndices.length;
    return vec2(cx / n, cy / n);
  }

  getHullPolygon(): Vec2[] {
    return this.world.getHullPolygon(this.blobId);
  }

  isExpanding(): boolean {
    return this.expandPressed;
  }

  /** The X/Y stick values the blob USED for this tick's physics, captured
   * by `setInput` at the start of the tick. The host's network broadcast
   * must use THESE values (not the latest `ManagedPlayer.moveX/Y` which
   * may have been overwritten by an async input event arriving AFTER
   * physics ran) — otherwise host's physics and guest's physics diverge
   * by one tick whenever the input changes mid-tick on the host. */
  getStickX(): number {
    return this.stickX;
  }
  getStickY(): number {
    return this.stickY;
  }

  getExpandScale(): number {
    return this.expandShapeScale;
  }

  /**
   * Reconcile this client's blob centroid toward an authoritative target.
   * `alpha` is the fraction of the gap to close this call (0..1) — small
   * values keep motion smooth while still erasing drift over a few snapshots.
   */
  nudgeCentroidToward(target: Vec2, alpha: number): void {
    const c = this.getCentroid();
    const dx = (target.x - c.x) * alpha;
    const dy = (target.y - c.y) * alpha;
    this.world.nudgeBlob(this.blobId, dx, dy);
  }

  /** Hard reset to a position, zeroing velocity. Used to recover from large drift. */
  teleportTo(target: Vec2): void {
    this.world.teleportBlob(this.blobId, target);
  }

  /**
   * Override the expand state on a non-authoritative client. Mirrors what
   * happens when a real input arrives via setExpandPressed, but skips the
   * input-rate gating so the value sticks until the next correction.
   */
  setExpandStateExternal(pressed: boolean, scale: number): void {
    this.expandPressed = pressed;
    this.expandShapeScale = Math.max(0.35, Math.min(3.5, scale));
    this.world.setBlobShapeMatchRestScale(this.blobId, this.expandShapeScale);
  }

  /** Rollback snapshot. Per-blob state that mutates each tick. */
  dumpState(): {
    expandPressed: boolean;
    expandWasPressed: boolean;
    stickX: number;
    stickY: number;
    expandShapeScale: number;
    gravityOverride: Vec2 | null;
    stuckTo: { normal: Vec2 } | null;
    stickReleaseGrace: number;
    moveForceMultiplier: number;
    expandSpeedMultiplier: number;
  } {
    return {
      expandPressed: this.expandPressed,
      expandWasPressed: this.expandWasPressed,
      stickX: this.stickX,
      stickY: this.stickY,
      expandShapeScale: this.expandShapeScale,
      gravityOverride: this.gravityOverride ? { x: this.gravityOverride.x, y: this.gravityOverride.y } : null,
      stuckTo: this.stuckTo ? { normal: { x: this.stuckTo.normal.x, y: this.stuckTo.normal.y } } : null,
      stickReleaseGrace: this.stickReleaseGrace,
      moveForceMultiplier: this.moveForceMultiplier,
      expandSpeedMultiplier: this.expandSpeedMultiplier,
    };
  }

  restoreState(state: ReturnType<SlimeBlob['dumpState']>): void {
    this.expandPressed = state.expandPressed;
    this.expandWasPressed = state.expandWasPressed;
    this.stickX = state.stickX;
    this.stickY = state.stickY;
    this.expandShapeScale = state.expandShapeScale;
    this.gravityOverride = state.gravityOverride ? { x: state.gravityOverride.x, y: state.gravityOverride.y } : null;
    this.stuckTo = state.stuckTo ? { normal: { x: state.stuckTo.normal.x, y: state.stuckTo.normal.y } } : null;
    this.stickReleaseGrace = state.stickReleaseGrace;
    this.moveForceMultiplier = state.moveForceMultiplier;
    this.expandSpeedMultiplier = state.expandSpeedMultiplier;
  }
}

function moveToward(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}
