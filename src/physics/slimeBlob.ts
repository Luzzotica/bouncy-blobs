import { SoftBodyWorld } from './softBodyWorld';
import { Vec2, vec2, ZERO } from './vec2';
import * as Tuning from './tuning';
import * as HullPresets from './hullPresets';
import { BlobResult } from './types';

export type HullPreset = 'circle16' | 'square' | 'triangle' | 'star' | 'diamond' | 'hexagon';

const BLOB_RADIUS = 48;
// Forces are now per-second (multiplied by dt in applyBlobMoveForce).
// Old per-frame values (2.0 / 1.5 / 0.8) scaled by 60 to preserve 60fps feel.
const MOVE_FORCE = 240.0;
const AIR_MOVE_MULTIPLIER = 0.3;
const PLAYER_K_MULT = 0.92;
const PLAYER_MASS_MULT = 0.5;
const EXPAND_SPRING_STIFFNESS_MULT = 1.45;

// Joystick shape deformation
const LEAN_AMOUNT = 0.4;       // 40% of radius — exaggerated tilt at max speed
const LEAN_MAX_SPEED = 3500;   // lateral speed (px/s) at which lean maxes out
const SQUASH_X_AMOUNT = 0.35;  // widen 35% at full crouch
const SQUASH_Y_AMOUNT = 0.3;   // shorten 30% at full crouch
const DOWN_FORCE = 180.0;      // downward force (per-second)
const UP_FORCE = 96.0;         // upward force (per-second, gentle float)

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

  private world: SoftBodyWorld;
  private expandPressed = false;
  private expandWasPressed = false;
  private stickX = 0;  // raw joystick input (world-space)
  private stickY = 0;
  private expandShapeScale = 1.0;
  private baseHullLocal: Vec2[];
  private deformedHullLocal: Vec2[];
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

  constructor(world: SoftBodyWorld, worldOrigin: Vec2, config: SlimeBlobConfig = {}) {
    this.world = world;
    this.playerControlled = config.playerControlled ?? true;
    this.expandShapeScaleMax = config.expandShapeScaleMax ?? 3.0;
    this.expandShapeScaleSpeed = config.expandShapeScaleSpeed ?? 6.75;
    this.expandShapeScaleSpeedPress = config.expandShapeScaleSpeedPress ?? 36.0;

    const hullPreset = config.hullPreset ?? 'circle16';
    const hullLocal = getHullLocal(hullPreset);
    const pk = this.playerControlled;

    const sk = Tuning.SPRING_K * (pk ? PLAYER_K_MULT : 1);
    const sd = Tuning.SPRING_DAMP;
    const rk = Tuning.RADIAL_K * (pk ? PLAYER_K_MULT : 1);
    const rd = Tuning.RADIAL_DAMP;
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
    });

    this.blobId = result.blobId;
    this.hullIndices = result.hullIndices;
    this.centerIdx = result.centerIdx;
    this.shapeIdx = result.shapeIdx;
    this.baseHullLocal = hullLocal.map(v => ({ ...v }));
    this.deformedHullLocal = hullLocal.map(v => ({ ...v }));
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

  setGravityOverride(g: Vec2 | null): void {
    this.gravityOverride = g;
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
        // Release: launch along aim, clear stuck state, set grace timer.
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

    // Build gravity-relative frame
    // "down" = gravity direction, "right" = perpendicular (90° CW from down)
    const down = this.getGravityDir();
    const right = vec2(down.y, -down.x); // perpendicular, 90° CCW from down
    const up = vec2(-down.x, -down.y);

    // Map joystick into gravity-relative world directions
    // stickX: left/right perpendicular to gravity
    // stickY: positive = along gravity (down), negative = against gravity (up)
    const moveDir = vec2(
      right.x * this.stickX + down.x * this.stickY,
      right.y * this.stickX + down.y * this.stickY,
    );

    // Lateral movement — reduced in air
    const grounded = this.world.getBlobGroundContacts(this.blobId) > 0;
    const airMult = grounded ? 1.0 : AIR_MOVE_MULTIPLIER;
    const lateralDir = vec2(right.x * this.stickX, right.y * this.stickX);
    this.world.applyBlobMoveForce(this.blobId, lateralDir, MOVE_FORCE * this.moveForceMultiplier * airMult, delta);

    // Gravity-axis forces from joystick Y
    if (this.stickY > 0.1) {
      // Pulling "down" (along gravity) — fall faster / crouch
      this.world.applyBlobMoveForce(this.blobId, down, DOWN_FORCE * this.stickY * this.moveForceMultiplier, delta);
    } else if (this.stickY < -0.1) {
      // Pushing "up" (against gravity) — gentle float
      this.world.applyBlobMoveForce(this.blobId, up, UP_FORCE * -this.stickY * this.moveForceMultiplier, delta);
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
    const n = this.baseHullLocal.length;

    // Lean: based on velocity along the "right" axis (perpendicular to gravity)
    const vLateral = this.getHullVelocityAlong(right);
    const leanFactor = Math.max(-1, Math.min(1, vLateral / LEAN_MAX_SPEED));

    // Squash: when pushing joystick "down" (along gravity)
    const squash = Math.max(0, this.stickY);

    // The base hull is defined in local space where Y points down, X points right.
    // We need to apply deformations along the gravity-relative axes.
    // Project each base hull point onto the gravity frame:
    //   localRight = base dot right_local, localDown = base dot down_local
    // For default gravity (0,1): down_local=(0,1), right_local=(1,0) — matches base coords.
    // For rotated gravity we need to rotate the base points into the gravity frame,
    // apply deformation, then rotate back.

    // Gravity frame axes in local space (local space has no rotation yet —
    // shape matching handles world rotation). Since base hull is defined with
    // Y=down, X=right, and gravity may not align with that, we compute the
    // gravity direction in local space. But rest positions are in local space
    // which is unrotated — the shape matching frame handles rotation.
    // So we need the gravity direction relative to the blob's current orientation.
    //
    // For now: the gravity frame in local space is just the world gravity direction
    // projected through the blob's inverse rotation. But since shape matching
    // computes rotation from rest→current, and rest positions are in a fixed frame,
    // we should apply deformation in the world-gravity frame projected into local space.
    //
    // Simpler approach: since the base hull is axis-aligned (Y=down by default),
    // and gravity is expressed in world space, we rotate the gravity frame into
    // the hull's local space. The hull's local space is unrotated, so down_local = down_world
    // when the blob hasn't rotated. But the blob DOES rotate in world space via shape matching.
    // The rest positions are always in the same local frame though.
    //
    // Actually — rest positions are in a fixed local frame. Shape matching rotates them
    // to match the blob's world orientation. So deformations to restLocal should be in
    // that fixed local frame. The "gravity down" in local frame = world gravity rotated
    // by the NEGATIVE of the blob's current rotation angle.

    // Get blob's current rotation angle (from shape matching)
    const blobAngle = this.getBlobAngle();
    // Rotate world gravity into local frame
    const cosA = Math.cos(-blobAngle);
    const sinA = Math.sin(-blobAngle);
    const localDown = vec2(
      down.x * cosA - down.y * sinA,
      down.x * sinA + down.y * cosA,
    );
    const localRight = vec2(-localDown.y, localDown.x);

    // Squash scales: widen along localRight, shorten along localDown
    const scaleRight = 1 + squash * SQUASH_X_AMOUNT;
    const scaleDown = 1 - squash * SQUASH_Y_AMOUNT;

    for (let i = 0; i < n; i++) {
      const base = this.baseHullLocal[i];

      // Project base point onto gravity-local axes
      const projRight = base.x * localRight.x + base.y * localRight.y;
      const projDown = base.x * localDown.x + base.y * localDown.y;

      // Apply squash scaling in gravity frame
      const scaledRight = projRight * scaleRight;
      const scaledDown = projDown * scaleDown;

      // Lean: offset along gravity axis based on lateral position
      // Points further in the "right" direction get pushed "down" when moving right
      const leanOffset = (projRight / BLOB_RADIUS) * -leanFactor * LEAN_AMOUNT * BLOB_RADIUS;

      // Reconstruct in local space
      this.deformedHullLocal[i].x = localRight.x * scaledRight + localDown.x * (scaledDown + leanOffset);
      this.deformedHullLocal[i].y = localRight.y * scaledRight + localDown.y * (scaledDown + leanOffset);
    }

    this.world.setBlobRestLocal(this.blobId, this.deformedHullLocal);
  }

  private getBlobAngle(): number {
    // Compute average rotation angle same way shape matching does
    const positions = this.world.getPositions();
    let cx = 0, cy = 0;
    for (const idx of this.hullIndices) {
      cx += positions[idx].x;
      cy += positions[idx].y;
    }
    const n = this.hullIndices.length;
    cx /= n;
    cy /= n;

    // Average angle between rest positions and current positions relative to centroid
    let sinSum = 0, cosSum = 0;
    for (let i = 0; i < n; i++) {
      const rest = this.baseHullLocal[i];
      const idx = this.hullIndices[i];
      const dx = positions[idx].x - cx;
      const dy = positions[idx].y - cy;
      // Cross product and dot product give sin/cos of rotation
      cosSum += rest.x * dx + rest.y * dy;
      sinSum += rest.x * dy - rest.y * dx;
    }
    return Math.atan2(sinSum, cosSum);
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
}

function moveToward(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}
