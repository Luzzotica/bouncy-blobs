import type { SoftBodyEngine } from './SoftBodyEngine';
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
// Airborne lateral authority. 0.3 felt too weak — players couldn't brake or
// steer mid-jump and kept overshooting platforms.
const AIR_MOVE_MULTIPLIER = 0.6;
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
// Lateral move force on non-floor surfaces (walls / ceilings). Contact friction
// is low there, so full force lets you zoom across a ceiling faster than the
// ground — this throttles it. Kept below floor (1.0); air has its own
// AIR_MOVE_MULTIPLIER.
const NONFLOOR_MOVE_MULT = 0.4;
// Climb up-force scale on vertical WALLS (vs ceilings). Keeps the strong UP for
// sticking under a ceiling but cuts it on walls so you can't shoot straight up.
const WALL_CLIMB_MULT = 0.35;

// Hull "treadmill": circulate the hull-perimeter points so the blob looks
// like a WHEEL rolling over whatever surface it's on. Purely visual — the
// surface flows, it doesn't push the body. Rolling-without-slip: the tread's
// surface speed tracks how fast we're moving ALONG the contact surface, and
// the roll direction is the rolling sense `n × v` (n = contact normal) — so
// it rolls correctly on floor, wall, or ceiling with no special-casing. A
// stopped blob doesn't spin; a fast one spins fast.
const TREAD_ROLL_GAIN = 7.0;   // tread circulation rate per px/s of surface speed (tune by feel)
// Lively spin floor: while STEERING, the wheel spins this hard even at a crawl,
// so a grippy floor that friction pins to a low speed still looks alive — the
// same gusto you get gliding fast on a (near-frictionless) ceiling. Scaled by
// |stick| for analog control, and added on top of the speed-proportional term.
const TREAD_STEER_BASE = 4800;
// Direction at a standstill: the intent term (±1) is scaled to this px/s so it
// sets the roll sense when surfaceSpeed≈0, but real motion (which is larger)
// takes over once you're moving. ~0 on walls (intent is horizontal), so wall
// roll direction comes purely from actual vertical motion.
const DIR_INTENT_BIAS = 120;
// Rolling and leaning are competing visuals — a leaned (sheared) rest shape is
// a rotational detent that stalls the spin. Fade lean while steering.
const LEAN_ROLL_SUPPRESS = 0.15;
// Master switch for the hull lean deformation. OFF while we test whether the
// lean shear is what makes the wheel feel "stuck". Flip back to true to restore.
const HULL_LEAN_ENABLED = false;
const TREAD_MIN_SPEED = 6;     // px/s deadzone so jitter doesn't spin a near-stopped blob
// ±1 — flips the overall roll direction if the wheel turns the wrong way.
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
   * `SoftBodyEngine.addBlobFromHull`'s `sortKey` parameter. Pass the
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
  /** True once destroy() has retired this blob from the physics world. Callers
   *  (e.g. the renderer) skip destroyed blobs so a retired NPC stops drawing. */
  destroyed = false;

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
    // TEMP jump test (lever 1: how FAST we expand). 36 → 24: a slower press-ramp
    // means a gentler push-off against the surface → lower jump. Tune to taste.
    this.expandShapeScaleSpeedPress = config.expandShapeScaleSpeedPress ?? 24.0;

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
    this.destroyed = true;
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

  /** True while the blob is stuck to a wall — which is exactly when the Rust
   * engine is pinning every particle to a saved snapshot each substep
   * (`pinBlobToCurrentPose`), overriding all physics until release. Exposed for
   * the debug overlay so the pinned state is observable. */
  get isPinned(): boolean {
    return this.stuckTo !== null;
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

  /** True when something is pressing on the blob's upper half (relative to
   * gravity) — a ledge, roof, or another blob / softbody platform resting
   * above. Drives the 12× UP_FORCE so the player can clamber up into / stick
   * under it. The per-particle contact bitmap is set for softbody contacts
   * too (see resolve_point_in_shape in world.rs), so this works uniformly for
   * hardbody and softbody surfaces. Unlike a strict ledge "hang" it does NOT
   * require the lower half to be free, so it also fires when standing under
   * an overhang. */
  private hasOverheadContact(): boolean {
    return this.contactSplit().upper >= LEDGE_HANG_MIN_UPPER_CONTACTS;
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

    // Gravity-relative frame. Movement scheme:
    //   - LATERAL (stickX) is GRAVITY-RELATIVE: A/D push ALONG the floor
    //     (perpendicular to gravity), whatever orientation the floor is at.
    //     World-fixed X used to be used here for "muscle memory", but under
    //     sideways/tilted gravity that aims the force INTO the floor-wall, so
    //     the player just floats and can't traverse. Aligning to `right` makes
    //     A/D always walk along the surface, and feeds the tread-rate sample
    //     below (which projects hull velocity onto `right`).
    //   - DOWN/UP (stickY) stays gravity-relative: push "toward gravity"
    //     to crouch / fall faster, push "against gravity" to float. This
    //     is the "physical" axis — pushing harder into whatever the floor
    //     IS, regardless of orientation.
    //   - JUMP is the soft-body expand, which physically pushes off
    //     whatever surface you're touching — gravity-agnostic by design.
    const down = this.getGravityDir();
    const right = vec2(down.y, -down.x); // perpendicular, gravity-relative
    const up = vec2(-down.x, -down.y);

    // Contact state. `touching` = any contact at all (floor, wall, ledge, or
    // another blob / softbody platform). `onFloor` = a floor-FACING contact
    // (normal points up) — only this gets full movement authority. The
    // per-particle bitmap + contact counts are snapshotted, so rollback-safe.
    const contacts = this.world.getBlobParticleContacts(this.blobId);
    let touching = false;
    for (let i = 0; i < contacts.length; i++) { if (contacts[i]) { touching = true; break; } }
    const onFloor = this.world.getBlobGroundContacts(this.blobId) > 0;
    // Surface orientation from the representative contact normal: +1 floor,
    // ~0 wall, -1 ceiling. Used to throttle non-floor movement.
    const cnorm = this.getGroundContact()?.normal ?? this.getImpactContact()?.normal ?? null;
    const upDot = cnorm ? (cnorm.x * up.x + cnorm.y * up.y) : (onFloor ? 1 : 0);
    // Something pressing on our upper half (ledge / roof / blob above).
    const overhead = this.hasOverheadContact();

    // Lateral movement — along the gravity-relative `right` axis (floor
    // tangent). Full on a floor, throttled on walls/ceilings (low friction
    // there would otherwise let you zoom) and in the air.
    const lateralMult = onFloor ? 1.0 : (touching ? NONFLOOR_MOVE_MULT : AIR_MOVE_MULTIPLIER);
    const lateralDir = vec2(right.x * this.stickX, right.y * this.stickX);
    this.world.applyBlobMoveForce(this.blobId, lateralDir, MOVE_FORCE * this.moveForceMultiplier * lateralMult, delta);

    // Gravity-axis forces from joystick Y — still gravity-relative so
    // "push down" always means "press into whatever the floor is".
    if (this.stickY > 0.1) {
      this.world.applyBlobMoveForce(this.blobId, down, DOWN_FORCE * this.stickY * this.moveForceMultiplier, delta);
    } else if (this.stickY < -0.1) {
      // UP only does something when there's a WALL to climb or a CEILING/ledge
      // to stick under — pressing up in open air or on flat ground gives NO
      // float (removed). Wall = contact normal ~horizontal; ceiling/ledge =
      // something overhead or a downward-facing contact normal.
      const isWall = cnorm !== null && Math.abs(upDot) < 0.5;
      const isCeilingStick = overhead || (cnorm !== null && upDot < -0.5);
      if (isWall || isCeilingStick) {
        // 12× clamber/stick force whenever something is pressing on our upper
        // half — a ledge, roof, OR another blob / softbody platform above us.
        const upMult = overhead ? LEDGE_UP_FORCE_MULT : 1.0;
        // Keep the strong UP for sticking UNDER a ceiling (normal points down,
        // upDot < 0) but cut it on a vertical WALL (normal ~horizontal) so you
        // can't shoot straight up a wall.
        const climbScale = (cnorm && upDot > -0.5) ? WALL_CLIMB_MULT : 1.0;
        this.world.applyBlobMoveForce(this.blobId, up, UP_FORCE * upMult * -this.stickY * this.moveForceMultiplier * climbScale, delta);
      }
    }

    // Hull rolls like a wheel. The roll direction comes from the velocity ALONG
    // the contact surface: `surfaceSpeed = v · tangent` where the tangent is the
    // contact normal rotated 90° (so v·tangent == n×v, the roll sense). This
    // auto-rolls the right way on floor / wall / ceiling. Falls back to the
    // gravity-relative frame when airborne, and reverses when clambering UP into
    // an overhead surface so it climbs up & over.
    //
    // Rate = a lively STEER_BASE (while steering) + a speed-proportional ramp.
    // The base keeps the wheel alive on a grippy floor where friction pins your
    // speed low; the ramp keeps the beloved fast spin when you glide quick on a
    // near-frictionless ceiling. Not steering → free-roll from actual motion.
    const rollNormal = cnorm ?? up;                          // points out of the surface, into the blob
    const rollTangent = vec2(-rollNormal.y, rollNormal.x);   // CCW tangent along the surface
    const surfaceSpeed = this.getHullVelocityAlong(rollTangent);
    // Only roll when there's LEFT/RIGHT movement — either steering intent
    // (A/D) or actual horizontal motion along the gravity-relative `right`
    // axis. Vertical motion (falling, jumping, climbing a wall) no longer
    // spins the wheel; the roll magnitude is still velocity-based as before.
    const horizontalSpeed = this.getHullVelocityAlong(right);
    const steering = Math.abs(this.stickX) > 0.1;
    let tread: number;
    if (steering) {
      // Direction = ACTUAL rolling sense (surfaceSpeed = n×v), so it's correct
      // on floor, ceiling AND walls (where motion is vertical). The intent term
      // only biases the sign at a standstill so it doesn't flicker; it's ~0 on
      // walls, so wall direction comes purely from how you're climbing.
      const intentAlong = (right.x * rollTangent.x + right.y * rollTangent.y) * this.stickX;
      const dir = Math.sign(surfaceSpeed + intentAlong * DIR_INTENT_BIAS) || 1;
      tread = dir * (TREAD_STEER_BASE * Math.abs(this.stickX) + TREAD_ROLL_GAIN * Math.abs(surfaceSpeed));
    } else if (Math.abs(surfaceSpeed) >= TREAD_MIN_SPEED && Math.abs(horizontalSpeed) >= TREAD_MIN_SPEED) {
      // Free-rolling (sliding / knocked back): follow actual motion, but only
      // when that motion is horizontal — gated on `horizontalSpeed` so purely
      // vertical movement doesn't roll the wheel.
      tread = TREAD_ROLL_GAIN * surfaceSpeed;
    } else {
      tread = 0;
    }
    this.world.setBlobTread(this.blobId, tread * TREAD_SIGN);

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
    let lean = HULL_LEAN_ENABLED ? Math.max(-1, Math.min(1, vLateral / LEAN_MAX_SPEED)) : 0;
    // Fade the lean while steering: a leaned (sheared) rest shape forms a
    // rotational detent that stalls the rolling tread. Round wheel rolls; leaned
    // wheel jams.
    if (HULL_LEAN_ENABLED && Math.abs(this.stickX) > 0.1) lean *= LEAN_ROLL_SUPPRESS;
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
   * Reset to a CLEAN rest pose at `center` (defaults to the current centroid):
   * rebuild the hull at its undeformed rest shape, deflate the expand state,
   * and zero velocity. Used on respawn.
   *
   * The hull rebuild + velocity clear happens in the Rust engine
   * (`resetBlobToRest`) — physics lives in Rust. Here we only reset the
   * TS-owned expand integrator so the blob doesn't come back oversized
   * ("BIG mode").
   */
  respawnReset(center?: Vec2): void {
    const c = center ?? this.getCentroid();
    this.expandPressed = false;
    this.expandWasPressed = false;
    this.expandShapeScale = 1.0;
    this.world.resetBlobToRest(this.blobId, c);
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

