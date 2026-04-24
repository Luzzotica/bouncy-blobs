import { SoftBodyWorld } from './softBodyWorld';
import { Vec2, vec2, ZERO } from './vec2';
import * as Tuning from './tuning';
import * as HullPresets from './hullPresets';
import { BlobResult } from './types';

export type HullPreset = 'circle16' | 'square' | 'triangle' | 'star' | 'diamond' | 'hexagon';

const BLOB_RADIUS = 48;
const MOVE_FORCE = 2.0;
const AIR_MOVE_MULTIPLIER = 0.3;
const PLAYER_K_MULT = 0.92;
const PLAYER_MASS_MULT = 0.5;
const EXPAND_SPRING_STIFFNESS_MULT = 1.45;

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
  private moveInput: Vec2 = ZERO;
  private expandShapeScale = 1.0;

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

  setInput(moveX: number, expand: boolean): void {
    this.moveInput = vec2(Math.max(-1, Math.min(1, moveX)), 0);
    this.expandPressed = expand;
  }

  update(delta: number): void {
    if (!this.playerControlled) return;

    // Spring stiffness while expanding
    const expandSpringMult = this.expandPressed ? EXPAND_SPRING_STIFFNESS_MULT : 1.0;
    this.world.setBlobSpringStiffnessScale(this.blobId, expandSpringMult);

    // Movement — reduced in air (no ground contacts)
    const grounded = this.world.getBlobGroundContacts(this.blobId) > 0;
    const airMult = grounded ? 1.0 : AIR_MOVE_MULTIPLIER;
    this.world.applyBlobMoveForce(this.blobId, this.moveInput, MOVE_FORCE * this.moveForceMultiplier * airMult);

    // Expand shape scale animation
    const targetShapeScale = this.expandPressed ? this.expandShapeScaleMax : 1.0;
    const baseRate = targetShapeScale > this.expandShapeScale
      ? this.expandShapeScaleSpeedPress
      : this.expandShapeScaleSpeed;
    const rampRate = baseRate * this.expandSpeedMultiplier;
    this.expandShapeScale = moveToward(this.expandShapeScale, targetShapeScale, rampRate * delta);
    this.world.setBlobShapeMatchRestScale(this.blobId, this.expandShapeScale);
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
}

function moveToward(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}
