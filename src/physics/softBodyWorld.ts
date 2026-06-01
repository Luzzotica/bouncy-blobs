import { Vec2, vec2, add, sub, scale, dot, length, lengthSq, normalize, negate, distanceTo, ZERO, RIGHT } from './vec2';
import { Spring, BlobRange, Shape, Transform2D, BlobResult, PumpEdge, RayHit, AABB, SurfaceMaterial, MaterialParams, StaticSurface, GravityField } from './types';
import {
  polygonAABB, aabbOverlap, isPointInPolygon,
  closestPointOnPolygonBoundary, edgeVertexWeights,
  signedAreaPolygon, resolveThreeBodyVelocity,
} from './collision';
import { solveWeld, solveWeightedAnchor, solveDistanceMax } from './constraints';
import { centroidFromIndices, averageAngle, frameTransform, applyTransform } from './shapeMatching';
import { LAYER_DEFAULT, LAYER_BLOB, LAYER_CHAIN, LAYER_WORLD, LAYER_ALL, canCollide } from './layers';
import { createRng, type SeededRng } from '../lib/rng';

const EPS = 1e-6;

/** Evaluate a GravityField at a world position. Returns the gravity vector
 * to apply to a particle at that point. */
export function evalGravityField(field: GravityField, pt: Vec2): Vec2 {
  if (field.kind === 'uniform') return field.vector;
  // 'point' — attractor (positive strength) or repulsor (negative strength)
  const dx = field.center.x - pt.x;
  const dy = field.center.y - pt.y;
  const dSq = dx * dx + dy * dy;
  if (dSq < EPS) return { x: 0, y: 0 };
  const d = Math.sqrt(dSq);
  let mag: number;
  if (field.falloff === 'inverseSquare') {
    mag = field.strength / Math.max(dSq, 100); // softening to avoid singularity
  } else {
    mag = field.strength / Math.max(d, 10);
  }
  return { x: (dx / d) * mag, y: (dy / d) * mag };
}

/** Per-material restitution + friction overrides for static surfaces.
 * Each value is treated as a multiplier on the world's defaults so that
 * `default` keeps behavior unchanged. */
export const MATERIAL_PARAMS: Record<SurfaceMaterial, MaterialParams> = {
  default: { restitution: 0.0, frictionMu: 1.64 },
  ice:     { restitution: 0.0, frictionMu: 0.05 },
  sticky:  { restitution: 0.0, frictionMu: 4.0 },
  bouncy:  { restitution: 0.8, frictionMu: 0.3 },
};

export interface SoftBodyWorldConfig {
  gravity?: Vec2;
  gravityScale?: number;
  fixedDt?: number;
  substeps?: number;
  collisionMargin?: number;
  collisionRestitution?: number;
  constraintIters?: number;
  staticRestitution?: number;
  staticContactSlop?: number;
  blobBlobFrictionMu?: number;
  blobBlobFrictionImpulseScale?: number;
  staticEdgeFrictionMu?: number;
  staticFrictionMinTangSpeed?: number;
  staticFrictionNormalLoadScale?: number;
  hullVertexDampingPerSec?: number;
  centerHullDampingPerSec?: number;
  hullDampSkipAboveSpeed?: number;
  /** Seed for the world's deterministic RNG. Anything that affects physics
   * (AI decisions, spawn jitter, powerup type, spike spawn) consumes from
   * this stream — never `Math.random()`. Two clients seeded the same and
   * fed the same inputs in the same order produce identical states. */
  rngSeed?: number;
}

export class SoftBodyWorld {
  // Particle arrays
  pos: Vec2[] = [];
  vel: Vec2[] = [];
  mass: number[] = [];
  invMass: number[] = [];
  particleRadius: number[] = [];
  // Per-particle bitmask layer + mask. See physics/layers.ts.
  particleLayer: number[] = [];
  particleMask: number[] = [];

  // Springs — owned by blobs (each blob has a contiguous [springBegin, springEnd) range)
  springs: Spring[] = [];

  // Extra springs not owned by any blob (level-author point shapes, ropes, etc.).
  // Applied unconditionally each substep.
  extraSprings: Spring[] = [];

  // Home-position anchors: for each (idx, home) pull the particle back to its
  // rest world-position with the given stiffness/damping. Used by point shapes
  // to maintain their shape independent of edge springs.
  homeAnchors: { idx: number; home: Vec2; k: number; damp: number }[] = [];

  // Shapes & blobs
  shapes: Shape[] = [];
  blobRanges: BlobRange[] = [];

  // Static collision geometry
  staticSurfaces: StaticSurface[] = [];

  // Constraints
  private welds: [number, number][] = [];
  private anchors: { indicesA: number[]; weightsA: number[]; indicesB: number[]; weightsB: number[] }[] = [];
  private distanceMaxConstraints: [number, number, number][] = [];

  /**
   * Chains: ordered runs of particles where each adjacent pair must be no
   * more than `maxSegmentLength` apart. Solved sequentially by
   * {@link solveChains} with a forward+backward sweep per iteration — this
   * lets force propagate end-to-end faster than the general constraint
   * iteration loop can manage when the chain is long and the endpoints are
   * much heavier than the segments.
   */
  private chains: { particleIndices: number[]; maxSegmentLength: number; iterations: number }[] = [];

  // Trigger state
  private triggerPrev: Map<string, boolean> = new Map();

  // Ground contact tracking — reset each step, counts hull particles touching static geometry
  private blobGroundContacts: number[] = [];
  // First ground contact (point + outward surface normal + the static polygon)
  // captured this step, or null. Used by VFX to place splats on the actual
  // surface (and clip them to its polygon so goop never floats past a corner).
  private blobGroundContactPoint: (Vec2 | null)[] = [];
  private blobGroundContactNormal: (Vec2 | null)[] = [];
  private blobGroundContactPoly: (Vec2[] | null)[] = [];

  // Any-surface impact contact (walls/ceilings too) — captured each step, or null.
  // Used by VFX to spawn splats on walls/ceilings on hard impact.
  private blobImpactContactPoint: (Vec2 | null)[] = [];
  private blobImpactContactNormal: (Vec2 | null)[] = [];
  private blobImpactContactPoly: (Vec2[] | null)[] = [];

  // Sticky contact tracking — reset each step. count = hull particles touching a 'sticky' surface;
  // normalSum is the unnormalized sum of those contact normals (averaged on read).
  private blobStickyContactCount: number[] = [];
  private blobStickyContactNormalSum: Vec2[] = [];

  // Per-blob gravity override. null = use world gravity (or trigger override if inside one).
  private blobGravityOverride: (Vec2 | null)[] = [];

  // Snapshot-pinned blobs: every particle position is restored each substep
  // and velocity zeroed. Used by the sticky-wall stick state.
  private blobPinSnapshots: Map<number, Vec2[]> = new Map();

  // Timing
  private timeAccum = 0;

  // Config
  gravity: Vec2;
  gravityScale: number;
  fixedDt: number;
  substeps: number;
  collisionMargin: number;
  collisionRestitution: number;
  constraintIters: number;
  staticRestitution: number;
  staticContactSlop: number;
  blobBlobFrictionMu: number;
  blobBlobFrictionImpulseScale: number;
  staticEdgeFrictionMu: number;
  staticFrictionMinTangSpeed: number;
  staticFrictionNormalLoadScale: number;
  hullVertexDampingPerSec: number;
  centerHullDampingPerSec: number;
  hullDampSkipAboveSpeed: number;

  // Deterministic time + randomness — see SoftBodyWorldConfig.rngSeed.
  /** Monotonic logical tick counter. Incremented once per fixed-dt step by
   * the game loop. Use `tick * fixedDt` anywhere you'd otherwise reach for
   * `performance.now()`. */
  tick: number = 0;
  /** Seeded deterministic RNG. Replaces all physics-affecting `Math.random()`
   * calls. Particle/decal cosmetics still use `Math.random()`. */
  rng!: SeededRng;

  // Callbacks
  onTriggerEntered?: (triggerShapeIdx: number, blobId: number) => void;
  onTriggerExited?: (triggerShapeIdx: number, blobId: number) => void;

  constructor(config: SoftBodyWorldConfig = {}) {
    // Default seed is 1 — callers (BouncyBlobsGame, the determinism harness)
    // should pass their own. Mismatched seeds across host/guest cause
    // simulations to diverge immediately.
    this.rng = createRng(config.rngSeed ?? 1);
    this.gravityScale = config.gravityScale ?? 4.0;
    this.gravity = config.gravity ?? vec2(0, 980.0 * this.gravityScale);
    this.fixedDt = config.fixedDt ?? 1 / 60;
    this.substeps = config.substeps ?? 2;
    this.collisionMargin = config.collisionMargin ?? 0.5;
    this.collisionRestitution = config.collisionRestitution ?? 0.25;
    this.constraintIters = config.constraintIters ?? 8;
    this.staticRestitution = config.staticRestitution ?? 0.0;
    this.staticContactSlop = config.staticContactSlop ?? 4.0;
    this.blobBlobFrictionMu = config.blobBlobFrictionMu ?? 1.2;
    this.blobBlobFrictionImpulseScale = config.blobBlobFrictionImpulseScale ?? 1.0;
    this.staticEdgeFrictionMu = config.staticEdgeFrictionMu ?? 1.64;
    this.staticFrictionMinTangSpeed = config.staticFrictionMinTangSpeed ?? 0.06;
    this.staticFrictionNormalLoadScale = config.staticFrictionNormalLoadScale ?? 2.0;
    this.hullVertexDampingPerSec = config.hullVertexDampingPerSec ?? 0.012;
    this.centerHullDampingPerSec = config.centerHullDampingPerSec ?? 0.004;
    this.hullDampSkipAboveSpeed = config.hullDampSkipAboveSpeed ?? 220.0;
  }

  // --- Public API ---

  registerStaticPolygon(
    poly: Vec2[],
    material: SurfaceMaterial = 'default',
    id?: string,
    opts: { layer?: number; mask?: number } = {},
  ): StaticSurface {
    const surface: StaticSurface = {
      poly: poly.map(p => ({ ...p })),
      material,
      id,
      layer: opts.layer ?? LAYER_WORLD,
      mask: opts.mask ?? LAYER_ALL,
    };
    this.staticSurfaces.push(surface);
    return surface;
  }

  /** Remove a previously registered static surface (linear splice). */
  removeStaticSurface(surface: StaticSurface): void {
    const i = this.staticSurfaces.indexOf(surface);
    if (i >= 0) this.staticSurfaces.splice(i, 1);
  }

  clearStaticPolygons(): void {
    this.staticSurfaces.length = 0;
  }

  /**
   * @param gravityOverride Pass a Vec2 for a uniform override (back-compat),
   *   or a tagged GravityField for point attractors / custom fields. ZERO
   *   means "no override" — the blob keeps world gravity inside the trigger.
   */
  registerTriggerPolygon(poly: Vec2[], gravityOverride: Vec2 | GravityField = ZERO): number {
    let field: GravityField | null = null;
    if ('kind' in gravityOverride) {
      field = gravityOverride;
    } else if (lengthSq(gravityOverride) > 0.0001) {
      field = { kind: 'uniform', vector: gravityOverride };
    }
    const shape: Shape = {
      indices: [],
      staticPoly: [...poly],
      isTrigger: true,
      isStatic: true,
      targetRestArea: 0,
      pressureK: 0,
      shapeMatchK: 0,
      shapeMatchDamp: 0,
      restLocal: [],
      shapeMatchRestScale: 1,
      useFrameOverride: false,
      frameOverride: { cos: 1, sin: 0, tx: 0, ty: 0 },
      gravityField: field,
      centerIdx: -1,
    };
    this.shapes.push(shape);
    return this.shapes.length - 1;
  }

  addBlobFromHull(params: {
    hullRestLocal: Vec2[];
    centerLocal?: Vec2;
    centerMass: number;
    hullMass: number;
    springK: number;
    springDamp: number;
    radialK: number;
    radialDamp: number;
    pressureK: number;
    shapeMatchK: number;
    shapeMatchDamp: number;
    worldOrigin: Vec2;
    /** Stable cross-client identifier for this blob — used to sort collision
     * pair iteration so host and guest produce identical results even when
     * their local insertion order differs. Pass the playerId for player
     * blobs, the NPC id for NPCs, etc. Defaults to a hash of construction
     * order so single-player and tests that don't care still work. */
    sortKey?: string;
    /** Indices into hullRestLocal whose particles are locked in space
     * (mass=0, invMass=0). For soft platforms with fixed anchor points.
     * The center particle is never static. */
    staticHullIndices?: number[];
    /** When true, the center particle is also locked. Default false. */
    staticCenter?: boolean;
    /** When true, lock the shape-match frame to (worldOrigin, identity) so
     *  the blob stays rooted in place without requiring per-vertex anchors.
     *  Every hull particle is still dynamic — they can deform locally — but
     *  shape-match yanks them toward their original rest world position. */
    pinFrame?: boolean;
  }): BlobResult {
    const {
      hullRestLocal, centerLocal = ZERO,
      centerMass, hullMass, springK, springDamp,
      radialK, radialDamp, pressureK, shapeMatchK, shapeMatchDamp,
      worldOrigin, sortKey, staticHullIndices, staticCenter = false,
      pinFrame = false,
    } = params;

    const staticSet = new Set(staticHullIndices ?? []);

    const numHull = hullRestLocal.length;
    if (numHull < 3) throw new Error('Need at least 3 hull points');

    const start = this.pos.length;

    // Center particle
    this.pos.push(add(centerLocal, worldOrigin));
    this.vel.push(ZERO);
    const cMass = staticCenter ? 0 : centerMass;
    this.mass.push(cMass);
    this.invMass.push(cMass > 0.001 ? 1 / cMass : 0);
    this.particleRadius.push(0);
    this.particleLayer.push(LAYER_BLOB);
    this.particleMask.push(LAYER_ALL);

    // Hull particles
    const hullIndices: number[] = [];
    for (let i = 0; i < numHull; i++) {
      this.pos.push(add(hullRestLocal[i], worldOrigin));
      this.vel.push(ZERO);
      const isStatic = staticSet.has(i);
      const m = isStatic ? 0 : hullMass;
      this.mass.push(m);
      this.invMass.push(m > 0.001 ? 1 / m : 0);
      this.particleRadius.push(0);
      this.particleLayer.push(LAYER_BLOB);
      this.particleMask.push(LAYER_ALL);
      hullIndices.push(start + 1 + i);
    }

    const springBegin = this.springs.length;

    // Edge springs
    for (let i = 0; i < numHull; i++) {
      const jNext = (i + 1) % numHull;
      const ia = start + 1 + i;
      const ib = start + 1 + jNext;
      const rest = distanceTo(this.pos[ia], this.pos[ib]);
      this.springs.push([ia, ib, rest, springK, springDamp]);
    }

    // Shear springs (skip-1)
    if (numHull >= 4) {
      for (let i = 0; i < numHull; i++) {
        const jSkip = (i + 2) % numHull;
        const ia = start + 1 + i;
        const ib = start + 1 + jSkip;
        const rest = distanceTo(this.pos[ia], this.pos[ib]);
        this.springs.push([ia, ib, rest, springK * 0.85, springDamp]);
      }
    }

    // Radial springs
    for (let i = 0; i < numHull; i++) {
      const ip = start + 1 + i;
      let restR = distanceTo(centerLocal, hullRestLocal[i]);
      if (restR < 0.001) restR = 0.001;
      this.springs.push([start, ip, restR, radialK, radialDamp]);
    }

    const springEnd = this.springs.length;

    // Rest local positions (copy)
    const restLocal = hullRestLocal.map(v => ({ ...v }));

    // Target area
    const hullPoly = this.buildPolygonFromIndices(hullIndices);
    const targetArea = Math.abs(signedAreaPolygon(hullPoly));

    const shape: Shape = {
      indices: hullIndices,
      staticPoly: [],
      isTrigger: false,
      isStatic: false,
      targetRestArea: targetArea,
      pressureK,
      shapeMatchK,
      shapeMatchDamp,
      restLocal,
      shapeMatchRestScale: 1,
      useFrameOverride: pinFrame,
      frameOverride: { cos: 1, sin: 0, tx: worldOrigin.x, ty: worldOrigin.y },
      gravityField: null,
      centerIdx: start,
      layer: LAYER_BLOB,
      mask: LAYER_ALL,
    };
    this.shapes.push(shape);
    const shapeIdx = this.shapes.length - 1;

    const blobId = this.blobRanges.length;
    this.blobRanges.push({
      id: blobId,
      start,
      end: this.pos.length,
      hull: hullIndices,
      shapeIdx,
      springBegin,
      springEnd,
      springStiffnessScale: 1,
      springDampScale: 1,
      // Fallback sortKey for blobs whose caller doesn't supply one (tests,
      // editor, etc.). The string-padded blob id keeps lexicographic order
      // matching numeric order for up to 999,999 blobs — well beyond any
      // realistic count.
      sortKey: sortKey ?? `__blob_${String(blobId).padStart(6, '0')}`,
    });

    return { blobId, centerIdx: start, hullIndices, shapeIdx };
  }

  /**
   * Retire a blob from the simulation. Compacting the particle/spring/shape
   * arrays would shift indices and break every other blob's stored ids, so
   * instead we leave the slots in place and tag them inactive — every physics
   * pass early-skips inactive ranges. Particles are frozen (invMass=0, vel=0,
   * radius=0) so they can never participate in collisions or forces, and the
   * shape's hull is collapsed to a point off-screen to keep AABB tests cheap.
   */
  removeBlob(blobId: number): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const r = this.blobRanges[blobId];
    if (r.inactive) return;
    r.inactive = true;

    const GRAVEYARD = vec2(-1e7, -1e7);
    for (let i = r.start; i < r.end; i++) {
      this.invMass[i] = 0;
      this.mass[i] = 0;
      this.vel[i] = ZERO;
      this.pos[i] = GRAVEYARD;
      this.particleRadius[i] = 0;
    }

    if (r.shapeIdx >= 0 && r.shapeIdx < this.shapes.length) {
      this.shapes[r.shapeIdx].inactive = true;
    }

    this.baseMasses.delete(blobId);
    // Drop any cached trigger membership so stale "exited" events don't fire.
    for (const key of [...this.triggerPrev.keys()]) {
      if (key.endsWith(`_${blobId}`)) this.triggerPrev.delete(key);
    }
  }

  setBlobSpringStiffnessScale(blobId: number, stiffnessScale: number, dampScale = -1): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const r = this.blobRanges[blobId];
    const ss = Math.max(0.2, Math.min(4.0, stiffnessScale));
    const ds = dampScale < 0 ? Math.sqrt(ss) : Math.max(0.2, Math.min(4.0, dampScale));
    r.springStiffnessScale = ss;
    r.springDampScale = ds;
  }

  setBlobShapeMatchRestScale(blobId: number, s: number): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const si = this.blobRanges[blobId].shapeIdx;
    if (si < 0 || si >= this.shapes.length) return;
    const sh = this.shapes[si];
    if (sh.isStatic || sh.isTrigger) return;
    sh.shapeMatchRestScale = Math.max(0.35, Math.min(3.5, s));
  }

  /** Overwrite the shape-matching rest-local positions for a blob's hull. */
  setBlobRestLocal(blobId: number, restLocal: Vec2[]): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const si = this.blobRanges[blobId].shapeIdx;
    if (si < 0 || si >= this.shapes.length) return;
    const sh = this.shapes[si];
    if (sh.isStatic || sh.isTrigger) return;
    const n = Math.min(restLocal.length, sh.restLocal.length);
    for (let i = 0; i < n; i++) {
      sh.restLocal[i].x = restLocal[i].x;
      sh.restLocal[i].y = restLocal[i].y;
    }
  }

  /** JS-sim mirror of the Rust engine's `set_blob_squash_lean`. The TS
   *  sim is only used in unit tests where determinism across browser
   *  instances isn't a concern, so this can use `Math.cos/sin/atan2`
   *  directly. Production runs through the Rust path. */
  setBlobSquashLean(blobId: number, squash: number, lean: number, gravityDir: Vec2): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const si = this.blobRanges[blobId].shapeIdx;
    if (si < 0 || si >= this.shapes.length) return;
    const sh = this.shapes[si];
    if (sh.isStatic || sh.isTrigger) return;
    // The TS sim never stored a `baseRestLocal`. For test-only usage,
    // approximate by reading the rest hull from the blob range's stored
    // initial state — but the TS sim doesn't keep one, so this is a
    // no-op. Tests that need squash/lean exercise should run against the
    // Rust path. (This stub keeps the interface happy.)
    void squash; void lean; void gravityDir;
  }

  /** Scale all particle masses in a blob by a factor. Stores base masses for restore. */
  private baseMasses: Map<number, number[]> = new Map();

  setBlobMassScale(blobId: number, massScale: number): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const r = this.blobRanges[blobId];

    // Save base masses on first call
    if (!this.baseMasses.has(blobId)) {
      const bases: number[] = [];
      for (let i = r.start; i < r.end; i++) {
        bases.push(this.mass[i]);
      }
      this.baseMasses.set(blobId, bases);
    }

    const bases = this.baseMasses.get(blobId)!;
    for (let i = r.start; i < r.end; i++) {
      const base = bases[i - r.start];
      this.mass[i] = base * massScale;
      this.invMass[i] = this.mass[i] > 0 ? 1 / this.mass[i] : 0;
    }
  }

  /**
   * Translate every particle in a blob by (dx, dy) without touching velocities.
   * Used by clients to gently reconcile their local sim toward the host's
   * authoritative centroid each snapshot — keeps the blob's momentum and shape
   * deformation intact while pulling its position back in line.
   */
  nudgeBlob(blobId: number, dx: number, dy: number): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    if (dx === 0 && dy === 0) return;
    const r = this.blobRanges[blobId];
    for (let i = r.start; i < r.end; i++) {
      this.pos[i] = vec2(this.pos[i].x + dx, this.pos[i].y + dy);
    }
  }

  /** Teleport a blob to a new position, zeroing all velocities. */
  teleportBlob(blobId: number, target: Vec2): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const r = this.blobRanges[blobId];

    // Compute current centroid
    let cx = 0, cy = 0;
    for (const idx of r.hull) {
      cx += this.pos[idx].x;
      cy += this.pos[idx].y;
    }
    cx /= r.hull.length;
    cy /= r.hull.length;

    // Offset all particles
    const dx = target.x - cx;
    const dy = target.y - cy;
    for (let i = r.start; i < r.end; i++) {
      this.pos[i] = vec2(this.pos[i].x + dx, this.pos[i].y + dy);
      this.vel[i] = ZERO;
    }
  }

  resetBlobMassScale(blobId: number): void {
    if (!this.baseMasses.has(blobId)) return;
    this.setBlobMassScale(blobId, 1.0);
    this.baseMasses.delete(blobId);
  }

  applyExternalForcePoint(i: number, f: Vec2): void {
    if (i < 0 || i >= this.vel.length) return;
    this.vel[i] = add(this.vel[i], scale(f, this.invMass[i]));
  }

  /** Returns the number of hull particles currently in contact with ground-facing static geometry. */
  getBlobGroundContacts(blobId: number): number {
    if (blobId < 0 || blobId >= this.blobGroundContacts.length) return 0;
    return this.blobGroundContacts[blobId];
  }

  /** Set the ground-contact tally for a blob — used by network state sync
   * to restore a host-authoritative value on the guest. This tally is
   * populated during the collision pass of `step()` and READ by the
   * next tick's `SlimeBlob.update` (for the `grounded ? 1.0 :
   * AIR_MOVE_MULTIPLIER` switch). Without sync, a freshly-keyframed
   * client reads a stale or zero value for one tick and applies the
   * wrong horizontal-move force — a small per-tick drift that produces
   * a visible snap when the next keyframe corrects positions. */
  setBlobGroundContacts(blobId: number, count: number): void {
    if (blobId < 0) return;
    while (this.blobGroundContacts.length <= blobId) this.blobGroundContacts.push(0);
    this.blobGroundContacts[blobId] = Math.max(0, count | 0);
  }

  /** Returns a representative ground contact (point on the surface + outward
   * normal) captured during the most recent step, or null if the blob isn't
   * touching anything ground-facing. The point is on the actual surface and
   * the normal points away from it — both in world space. */
  getBlobGroundContact(blobId: number): { point: Vec2; normal: Vec2; poly: Vec2[] | null } | null {
    if (blobId < 0 || blobId >= this.blobGroundContactPoint.length) return null;
    const point = this.blobGroundContactPoint[blobId];
    const normal = this.blobGroundContactNormal[blobId];
    if (!point || !normal) return null;
    return {
      point: { x: point.x, y: point.y },
      normal: { x: normal.x, y: normal.y },
      poly: this.blobGroundContactPoly[blobId] ?? null,
    };
  }

  /** Returns a representative impact contact (any static surface — floor, wall,
   * or ceiling) captured during the most recent step, or null if the blob isn't
   * touching any static geometry. Used by VFX to spawn splats on hard impacts
   * regardless of surface orientation. */
  getBlobImpactContact(blobId: number): { point: Vec2; normal: Vec2; poly: Vec2[] | null } | null {
    if (blobId < 0 || blobId >= this.blobImpactContactPoint.length) return null;
    const point = this.blobImpactContactPoint[blobId];
    const normal = this.blobImpactContactNormal[blobId];
    if (!point || !normal) return null;
    return {
      point: { x: point.x, y: point.y },
      normal: { x: normal.x, y: normal.y },
      poly: this.blobImpactContactPoly[blobId] ?? null,
    };
  }

  /** Returns the number of hull points touching a 'sticky' material surface this step,
   * along with the averaged outward normal. Normal is ZERO if count is 0. */
  getBlobStickyContact(blobId: number): { count: number; normal: Vec2 } {
    if (blobId < 0 || blobId >= this.blobStickyContactCount.length) {
      return { count: 0, normal: ZERO };
    }
    const count = this.blobStickyContactCount[blobId];
    const sum = this.blobStickyContactNormalSum[blobId] ?? ZERO;
    if (count === 0 || lengthSq(sum) < EPS * EPS) return { count, normal: ZERO };
    return { count, normal: normalize(sum) };
  }

  /** Per-particle contact bitmap stub for the TS sim. The legacy TS path
   * doesn't track per-particle contacts; ledge-hang assist is Rust-only.
   * Returns an empty array so callers gracefully skip the boost. */
  getBlobParticleContacts(_blobId: number): Uint8Array {
    return new Uint8Array(0);
  }

  /** Per-blob gravity override. Pass null to clear. Takes precedence over trigger gravity. */
  setBlobGravityOverride(blobId: number, gravity: Vec2 | null): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    while (this.blobGravityOverride.length <= blobId) this.blobGravityOverride.push(null);
    this.blobGravityOverride[blobId] = gravity;
  }

  /** Freeze every particle of this blob in place. Snapshot taken now; each
   * substep restores positions and zeroes velocities until unpinBlob() is called. */
  pinBlobToCurrentPose(blobId: number): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const r = this.blobRanges[blobId];
    const snap: Vec2[] = [];
    for (let i = r.start; i < r.end; i++) {
      snap.push({ x: this.pos[i].x, y: this.pos[i].y });
    }
    this.blobPinSnapshots.set(blobId, snap);
  }

  unpinBlob(blobId: number): void {
    this.blobPinSnapshots.delete(blobId);
  }

  /** Zero out every particle velocity in this blob. Useful for state transitions. */
  zeroBlobVelocity(blobId: number): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const r = this.blobRanges[blobId];
    for (let i = r.start; i < r.end; i++) {
      this.vel[i] = { x: 0, y: 0 };
    }
  }

  applyBlobMoveForce(blobId: number, move: Vec2, force: number, dt: number): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const r = this.blobRanges[blobId];
    const f = scale(move, force * dt);
    for (let i = r.start; i < r.end; i++) {
      this.vel[i] = add(this.vel[i], scale(f, this.invMass[i]));
    }
  }

  applyBlobLinearVelocityDelta(blobId: number, deltaV: Vec2): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    if (lengthSq(deltaV) < 1e-12) return;
    const r = this.blobRanges[blobId];
    for (let i = r.start; i < r.end; i++) {
      this.vel[i] = add(this.vel[i], deltaV);
    }
  }

  // ---- Phase 3 zone-force APIs (interface compliance only) ----
  // The TS sim is non-deterministic by design (float math) and is
  // only used in unit tests. Production runs through the Rust engine
  // which has these implemented losslessly. These stubs satisfy the
  // SoftBodyEngine interface so the interface can require these
  // methods on all engines without breaking the TS sim's compile.
  blobsOverlappingPolygon(_polygon: Float64Array): Uint32Array {
    return new Uint32Array(0);
  }
  applyForceInPolygonUniform(_polygon: Float64Array, _fx: number, _fy: number, _dt: number): void {
    // no-op
  }
  applyForceInPolygonRadial(
    _polygon: Float64Array,
    _cx: number, _cy: number,
    _strength: number, _radius: number,
    _falloff: 0 | 1,
    _dt: number,
  ): void {
    // no-op
  }
  applyForceInPolygonDrag(_polygon: Float64Array, _coefficient: number, _dt: number): void {
    // no-op
  }

  // ---- Phase 4 dynamic-item stubs (interface compliance only) ----
  // TS sim doesn't run engine-side dynamic items — production uses Rust.
  addCannon(_id: number, _x: number, _y: number, _w: number, _h: number, _rotation: number): number { return -1; }
  addCatapult(_id: number, _x: number, _y: number, _w: number, _h: number): number { return -1; }
  addBumper(_id: number, _x: number, _y: number, _radius: number): number { return -1; }
  addWindZone(_id: number, _x: number, _y: number, _w: number, _h: number, _rotation: number): number { return -1; }
  addGravityFlipper(_id: number, _x: number, _y: number, _w: number, _h: number): number { return -1; }
  addConveyor(_id: number, _x: number, _y: number, _w: number, _h: number, _direction: 1 | -1): number { return -1; }
  addStickyGoo(_id: number, _x: number, _y: number, _w: number, _h: number): number { return -1; }
  addWreckingBall(_id: number, _x: number, _y: number): number { return -1; }
  clearDynamicItems(): void { /* no-op */ }
  dynamicItemCount(): number { return 0; }
  dynamicItemActive(_idx: number): boolean { return false; }

  // ---- Phase 5 spring-pad stubs ----
  addSpringPad(_id: number, _x: number, _y: number, _w: number, _h: number, _rotation: number, _fireSpeedOverride: number): number { return -1; }
  clearSpringPads(): void { /* no-op */ }
  springPadCount(): number { return 0; }
  springPadState(_idx: number): number { return 0; }
  springPadOffset(_idx: number): number { return 0; }
  takeSpringPadFireEvents(): Uint32Array { return new Uint32Array(0); }

  applyBlobExpand(blobId: number, expandForce: number): void {
    const edges = this.getBlobPumpEdgeImpulses(blobId, expandForce);
    for (const e of edges) {
      this.vel[e.i0] = add(this.vel[e.i0], scale(e.normal, e.impulse * this.invMass[e.i0]));
      this.vel[e.i1] = add(this.vel[e.i1], scale(e.normal, e.impulse * this.invMass[e.i1]));
    }
  }

  getBlobPumpEdgeImpulses(blobId: number, expandForce: number): PumpEdge[] {
    const out: PumpEdge[] = [];
    if (blobId < 0 || blobId >= this.blobRanges.length) return out;
    const r = this.blobRanges[blobId];
    const ci = r.start;
    const c = this.pos[ci];
    const hull = r.hull;
    const nh = hull.length;
    if (nh < 3) return out;

    let perim = 0;
    for (let k = 0; k < nh; k++) {
      perim += distanceTo(this.pos[hull[k]], this.pos[hull[(k + 1) % nh]]);
    }
    if (perim < 1e-6) return out;

    const pmul = this.blobPumpPressureMultiplier(blobId);
    const base = expandForce * pmul * (nh * 0.5);

    for (let k = 0; k < nh; k++) {
      const i0 = hull[k];
      const i1 = hull[(k + 1) % nh];
      const a = this.pos[i0];
      const b = this.pos[i1];
      const ed = sub(b, a);
      const el = length(ed);
      if (el < 1e-6) continue;
      const mid = scale(add(a, b), 0.5);
      let nOut: Vec2 = { x: -ed.y, y: ed.x };
      if (dot(nOut, sub(c, mid)) > 0) nOut = negate(nOut);
      nOut = normalize(nOut);
      const impulseEdge = base * (el / perim);
      out.push({ i0, i1, mid, normal: nOut, impulse: impulseEdge });
    }
    return out;
  }

  // --- Queries ---

  getPositions(): Vec2[] { return this.pos; }
  getVelocities(): Vec2[] { return this.vel.map(v => ({ ...v })); }
  getPointCount(): number { return this.pos.length; }
  getGravity(): Vec2 { return this.gravity; }

  /** Returns the effective gravity for a blob (accounting for trigger zone overrides). */
  getBlobEffectiveGravity(blobId: number): Vec2 {
    if (blobId < 0 || blobId >= this.blobRanges.length) return this.gravity;
    const r = this.blobRanges[blobId];
    const cx = centroidFromIndices(this.pos, r.hull);
    for (let si = 0; si < this.shapes.length; si++) {
      const sh = this.shapes[si];
      if (!sh.isTrigger) continue;
      if (sh.staticPoly.length === 0) continue;
      if (isPointInPolygon(cx, sh.staticPoly)) {
        if (sh.gravityField !== null) {
          return evalGravityField(sh.gravityField, cx);
        }
      }
    }
    return this.gravity;
  }

  getHullPolygon(blobId: number): Vec2[] {
    if (blobId < 0 || blobId >= this.blobRanges.length) return [];
    return this.buildPolygonFromIndices(this.blobRanges[blobId].hull);
  }

  getBlobCount(): number { return this.blobRanges.length; }

  getBlobMassPointIndexRange(blobId: number): { start: number; end: number } {
    if (blobId < 0 || blobId >= this.blobRanges.length) return { start: -1, end: -1 };
    const r = this.blobRanges[blobId];
    return { start: r.start, end: r.end };
  }

  getBlobCenterPointIndex(blobId: number): number {
    if (blobId < 0 || blobId >= this.blobRanges.length) return -1;
    return this.blobRanges[blobId].start;
  }

  getBlobIdForPointIndex(pointIdx: number): number {
    for (let bi = 0; bi < this.blobRanges.length; bi++) {
      const r = this.blobRanges[bi];
      if (pointIdx >= r.start && pointIdx < r.end) return bi;
    }
    return -1;
  }

  getSpringIndexPairs(): [number, number][] {
    return this.springs.map(s => [s[0], s[1]]);
  }

  getBlobShapeMatchTargetHull(blobId: number): Vec2[] {
    if (blobId < 0 || blobId >= this.blobRanges.length) return [];
    const si = this.blobRanges[blobId].shapeIdx;
    if (si < 0 || si >= this.shapes.length) return [];
    const sh = this.shapes[si];
    if (sh.isStatic || sh.isTrigger || sh.shapeMatchK <= 0) return [];
    const { indices, restLocal } = sh;
    if (indices.length !== restLocal.length || indices.length === 0) return [];

    let center: Vec2, angle: number;
    if (sh.useFrameOverride) {
      center = { x: sh.frameOverride.tx, y: sh.frameOverride.ty };
      angle = Math.atan2(sh.frameOverride.sin, sh.frameOverride.cos);
    } else {
      center = centroidFromIndices(this.pos, indices);
      angle = averageAngle(restLocal, this.pos, indices, center);
    }
    const frame = frameTransform(center, angle);
    const smScale = Math.max(sh.shapeMatchRestScale, 0.05);
    return indices.map((_, k) => applyTransform(frame, scale(restLocal[k], smScale)));
  }

  setHullPositions(blobId: number, hullPositions: Vec2[]): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const r = this.blobRanges[blobId];
    const hull = r.hull;
    if (hullPositions.length !== hull.length) return;
    let c: Vec2 = ZERO;
    for (let i = 0; i < hull.length; i++) {
      this.pos[hull[i]] = { ...hullPositions[i] };
      c = add(c, hullPositions[i]);
    }
    c = scale(c, 1 / hull.length);
    this.pos[r.start] = c;
    for (let j = r.start; j < r.end; j++) {
      this.vel[j] = ZERO;
    }
  }

  addParticle(p: Vec2, v: Vec2, m: number, radius: number): number {
    const idx = this.pos.length;
    this.pos.push({ ...p });
    this.vel.push({ ...v });
    this.mass.push(m);
    this.invMass.push(m > 0.001 ? 1 / m : 0);
    this.particleRadius.push(radius);
    return idx;
  }

  addWeld(i: number, j: number): void { this.welds.push([i, j]); }

  addDistanceMax(i: number, j: number, maxDist: number): void {
    this.distanceMaxConstraints.push([i, j, maxDist]);
  }

  /**
   * Build a discrete-particle rope between two existing particles. Creates
   * intermediate point particles connected by per-segment max-distance
   * constraints (no forces, no springs — the rope only pulls when a pair
   * exceeds its max segment length, and it pulls only that pair).
   *
   * The number of segments is derived from `totalLength / maxSegmentLength`.
   *
   * Each segment particle sits on `layer` (default LAYER_CHAIN) and
   * accepts `mask` (default LAYER_WORLD) — collides with world geometry
   * but not with blobs (including the two endpoints) or other chains.
   *
   * The chain is registered with a dedicated sequential solver
   * ({@link solveChains}) that runs forward+backward sweeps per substep
   * so force propagates end-to-end without being drowned out by other
   * constraints.
   *
   * @returns The newly-created interior particle indices in order.
   */
  addRopeChain(
    idxA: number,
    idxB: number,
    opts: {
      /** Target total rope length. Acts as a budget — actual rope can
       *  drape over geometry up to this length. */
      totalLength: number
      /** Max distance between any two adjacent chain points. Smaller →
       *  denser rope, more compute, less visual clip-through. */
      maxSegmentLength: number
      segmentMass?: number
      segmentRadius?: number
      layer?: number
      mask?: number
      /** Iterations of the chain-specific solver per substep.
       *  Each iteration does a forward + backward sweep. Default 12. */
      iterations?: number
    },
  ): { particleIndices: number[] } {
    const maxL = opts.maxSegmentLength;
    const segments = Math.max(2, Math.ceil(opts.totalLength / maxL));
    const segMass = opts.segmentMass ?? 0.5;
    const segRad = opts.segmentRadius ?? 10;
    const layer = opts.layer ?? LAYER_CHAIN;
    const mask = opts.mask ?? LAYER_WORLD;
    const iterations = Math.max(1, opts.iterations ?? 12);

    const pA = this.pos[idxA];
    const pB = this.pos[idxB];
    const newIndices: number[] = [];
    const innerCount = segments - 1;

    for (let s = 1; s <= innerCount; s++) {
      const t = s / segments;
      const p: Vec2 = { x: pA.x + (pB.x - pA.x) * t, y: pA.y + (pB.y - pA.y) * t };
      this.pos.push(p);
      this.vel.push({ x: 0, y: 0 });
      this.mass.push(segMass);
      this.invMass.push(segMass > 0.001 ? 1 / segMass : 0);
      this.particleRadius.push(segRad);
      this.particleLayer.push(layer);
      this.particleMask.push(mask);
      newIndices.push(this.pos.length - 1);
    }

    this.chains.push({
      particleIndices: [idxA, ...newIndices, idxB],
      maxSegmentLength: maxL,
      iterations,
    });

    return { particleIndices: newIndices };
  }

  addWeightedAnchor(indicesA: number[], weightsA: number[], indicesB: number[], weightsB: number[]): void {
    this.anchors.push({ indicesA, weightsA, indicesB, weightsB });
  }

  clearSimulation(): void {
    this.pos.length = 0;
    this.vel.length = 0;
    this.mass.length = 0;
    this.invMass.length = 0;
    this.particleRadius.length = 0;
    this.particleLayer.length = 0;
    this.particleMask.length = 0;
    this.springs.length = 0;
    this.shapes = this.shapes.filter(sh => sh.isTrigger);
    this.blobRanges.length = 0;
    this.welds.length = 0;
    this.anchors.length = 0;
    this.distanceMaxConstraints.length = 0;
    this.chains.length = 0;
    this.triggerPrev.clear();
    this.timeAccum = 0;
  }

  rayCast(origin: Vec2, dir: Vec2, maxDist: number): RayHit {
    const d = normalize(dir);
    const end = add(origin, scale(d, maxDist));
    let bestT = Infinity;
    let bestNormal: Vec2 = { x: 0, y: -1 };
    let hit = false;

    for (const surface of this.staticSurfaces) {
      const poly = surface.poly;
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        const result = segmentIntersection(origin, end, a, b);
        if (result !== null) {
          const t = distanceTo(origin, result);
          if (t < bestT) {
            bestT = t;
            const edge = sub(b, a);
            let nn = normalize({ x: edge.y, y: -edge.x });
            if (dot(nn, d) > 0) nn = negate(nn);
            bestNormal = nn;
            hit = true;
          }
        }
      }
    }

    return {
      hit,
      distance: bestT,
      position: hit ? add(origin, scale(d, bestT)) : end,
      normal: bestNormal,
    };
  }

  // --- Simulation step ---

  /**
   * Fraction of a fixed timestep remaining in the accumulator (0–1).
   * Use to interpolate rendering between physics frames.
   */
  get interpolationAlpha(): number {
    return this.timeAccum / this.fixedDt;
  }

  step(delta: number): void {
    // Always run exactly 1 physics tick per frame using the actual dt.
    // This avoids 0-step or 2-step frames that cause jitter with camera lerp.
    // Clamp dt to a safe range to prevent instability.
    const clampedDt = Math.min(Math.max(delta, 1 / 240), 1 / 20);
    this.fixedDt = clampedDt;
    for (let s = 0; s < this.substeps; s++) {
      this.substep();
    }
    // Monotonic tick — anything that needs a deterministic time source
    // (AI decision timers, replay tagging) should multiply this by
    // fixedDt instead of reading `performance.now`.
    this.tick += 1;
  }

  private substep(): void {
    const dt = this.fixedDt / this.substeps;
    const n = this.pos.length;
    if (n === 0) return;

    // 1. Build per-particle gravity (default = world gravity, override by triggers)
    const grav: Vec2[] = new Array(n);
    for (let i = 0; i < n; i++) grav[i] = this.gravity;

    for (let bi = 0; bi < this.blobRanges.length; bi++) {
      const r = this.blobRanges[bi];
      if (r.inactive) continue;
      const cx = centroidFromIndices(this.pos, r.hull);
      for (let si = 0; si < this.shapes.length; si++) {
        const sh = this.shapes[si];
        if (!sh.isTrigger) continue;
        if (sh.staticPoly.length === 0) continue;
        if (sh.gravityField === null) continue;
        if (!isPointInPolygon(cx, sh.staticPoly)) continue;
        // Uniform fields apply the same vector to all particles; point fields
        // re-evaluate per particle so the radial direction changes across the blob.
        if (sh.gravityField.kind === 'uniform') {
          for (let j = r.start; j < r.end; j++) grav[j] = sh.gravityField.vector;
        } else {
          for (let j = r.start; j < r.end; j++) grav[j] = evalGravityField(sh.gravityField, this.pos[j]);
        }
      }
    }

    // Per-blob gravity override (sticky-wall stick, etc.) — takes precedence over trigger overrides.
    for (let bi = 0; bi < this.blobRanges.length; bi++) {
      const r = this.blobRanges[bi];
      if (r.inactive) continue;
      const ov = this.blobGravityOverride[bi];
      if (!ov) continue;
      for (let j = r.start; j < r.end; j++) grav[j] = ov;
    }

    // 2. Apply gravity (skip anchored particles — invMass=0 means fixed in space)
    for (let i = 0; i < n; i++) {
      if (this.invMass[i] === 0) continue;
      this.vel[i] = add(this.vel[i], scale(grav[i], dt));
    }

    // 3-5. Forces
    this.applySprings(dt);
    this.applyPressure(dt);
    this.applyShapeMatching(dt);

    // 6. Semi-implicit Euler — save prev positions for CCD sweep
    // (skip integration for anchored particles so they never drift)
    const prevPos: Vec2[] = new Array(n);
    for (let i = 0; i < n; i++) {
      prevPos[i] = this.pos[i];
      if (this.invMass[i] === 0) {
        this.vel[i] = { x: 0, y: 0 };
        continue;
      }
      this.pos[i] = add(this.pos[i], scale(this.vel[i], dt));
    }

    // 6b. CCD sweep: detect and resolve tunneling through static geometry
    this.sweepStaticCCD(prevPos);
    // 6c. CCD sweep: detect and resolve tunneling between moving blobs.
    this.sweepBlobCCD(prevPos);

    // 7. Constraints
    for (let it = 0; it < this.constraintIters; it++) {
      for (const w of this.welds) solveWeld(this.pos, this.invMass, w[0], w[1]);
      for (const a of this.anchors) {
        solveWeightedAnchor(this.pos, this.invMass, a.indicesA, a.weightsA, a.indicesB, a.weightsB);
      }
      for (const d of this.distanceMaxConstraints) {
        solveDistanceMax(this.pos, this.invMass, d[0], d[1], d[2]);
      }
    }
    // Chain-specific solver — bi-directional sweeps over each rope. Runs
    // after the general constraint loop so the chain is enforced against
    // whatever the welds/anchors did, and before collisions so any
    // penetration the chain creates gets cleaned up.
    this.solveChains();

    // 8-9. Collisions — reset ground + sticky contact counts
    this.blobGroundContacts.length = this.blobRanges.length;
    this.blobStickyContactCount.length = this.blobRanges.length;
    this.blobStickyContactNormalSum.length = this.blobRanges.length;
    this.blobGroundContactPoint.length = this.blobRanges.length;
    this.blobGroundContactNormal.length = this.blobRanges.length;
    this.blobGroundContactPoly.length = this.blobRanges.length;
    this.blobImpactContactPoint.length = this.blobRanges.length;
    this.blobImpactContactNormal.length = this.blobRanges.length;
    this.blobImpactContactPoly.length = this.blobRanges.length;
    for (let i = 0; i < this.blobRanges.length; i++) {
      this.blobStickyContactCount[i] = 0;
      this.blobStickyContactNormalSum[i] = { x: 0, y: 0 };
      this.blobGroundContactPoint[i] = null;
      this.blobGroundContactNormal[i] = null;
      this.blobGroundContactPoly[i] = null;
      this.blobImpactContactPoint[i] = null;
      this.blobImpactContactNormal[i] = null;
      this.blobImpactContactPoly[i] = null;
    }
    this.blobGroundContacts.fill(0);
    this.solveCollisions(dt);
    this.solveParticleCollisions(dt);

    // 10. Triggers
    this.processTriggerEvents();

    // 11. Damping
    this.applyHullVelocityDamping(dt);

    // 12. Snapshot pins — for blobs frozen by the sticky-wall stick state,
    // restore every particle to its snapshot position and zero velocity.
    if (this.blobPinSnapshots.size > 0) {
      this.blobPinSnapshots.forEach((snap, blobId) => {
        if (blobId < 0 || blobId >= this.blobRanges.length) return;
        const r = this.blobRanges[blobId];
        if (r.inactive) return;
        for (let i = r.start, k = 0; i < r.end && k < snap.length; i++, k++) {
          this.pos[i] = { x: snap[k].x, y: snap[k].y };
          this.vel[i] = { x: 0, y: 0 };
        }
      });
    }
  }

  // --- Internal physics ---

  private applySprings(dt: number): void {
    for (let bi = 0; bi < this.blobRanges.length; bi++) {
      const r = this.blobRanges[bi];
      if (r.inactive) continue;
      const kMult = r.springStiffnessScale;
      const dMult = r.springDampScale;
      if (r.springBegin < 0 || r.springEnd < 0 || r.springBegin >= r.springEnd) continue;

      for (let sIdx = r.springBegin; sIdx < r.springEnd; sIdx++) {
        if (sIdx >= this.springs.length) break;
        const s = this.springs[sIdx];
        const ia = s[0], ib = s[1], rest = s[2], k = s[3] * kMult, damp = s[4] * dMult;
        const diff = sub(this.pos[ib], this.pos[ia]);
        const dist = length(diff);
        if (dist < 0.0001) continue;
        const dir = scale(diff, 1 / dist);
        const stretch = dist - rest;
        const relVel = dot(sub(this.vel[ib], this.vel[ia]), dir);
        const force = scale(dir, k * stretch + damp * relVel);

        if (this.invMass[ia] > 0) {
          this.vel[ia] = add(this.vel[ia], scale(force, this.invMass[ia] * dt));
        }
        if (this.invMass[ib] > 0) {
          this.vel[ib] = sub(this.vel[ib], scale(force, this.invMass[ib] * dt));
        }
      }
    }

    // Level-author springs (point shapes, ropes) — not owned by any blob.
    for (const s of this.extraSprings) {
      const ia = s[0], ib = s[1], rest = s[2], k = s[3], damp = s[4];
      const diff = sub(this.pos[ib], this.pos[ia]);
      const dist = length(diff);
      if (dist < 0.0001) continue;
      const dir = scale(diff, 1 / dist);
      const stretch = dist - rest;
      const relVel = dot(sub(this.vel[ib], this.vel[ia]), dir);
      const force = scale(dir, k * stretch + damp * relVel);
      if (this.invMass[ia] > 0) this.vel[ia] = add(this.vel[ia], scale(force, this.invMass[ia] * dt));
      if (this.invMass[ib] > 0) this.vel[ib] = sub(this.vel[ib], scale(force, this.invMass[ib] * dt));
    }

    // Home-position pulls — each unanchored particle is yanked back toward its
    // rest world-position. This is the "shape memory" that keeps a point-shape
    // platform from drifting when pushed.
    for (const ha of this.homeAnchors) {
      if (this.invMass[ha.idx] === 0) continue;
      const p = this.pos[ha.idx];
      const v = this.vel[ha.idx];
      const dx = ha.home.x - p.x;
      const dy = ha.home.y - p.y;
      const fx = ha.k * dx - ha.damp * v.x;
      const fy = ha.k * dy - ha.damp * v.y;
      this.vel[ha.idx] = { x: v.x + fx * this.invMass[ha.idx] * dt, y: v.y + fy * this.invMass[ha.idx] * dt };
    }
  }

  /**
   * Per-chain constraint solver. Each chain is a list of particles where
   * adjacent pairs must be no further apart than the chain's
   * `maxSegmentLength`. We do K iterations of a forward + backward sweep
   * over each chain so pull from either endpoint can propagate to the
   * other within a single substep — the general constraint loop can't do
   * this fast enough when blob centers are an order of magnitude heavier
   * than the chain segments.
   *
   * Cheap: a 30-segment chain at 12 iterations is ~720 `solveDistanceMax`
   * calls per substep. The math inside is sub + length + scale per pair.
   */
  private solveChains(): void {
    for (const chain of this.chains) {
      const idx = chain.particleIndices;
      const maxL = chain.maxSegmentLength;
      const K = chain.iterations;
      for (let it = 0; it < K; it++) {
        // Forward sweep — propagates pull from endpoint A toward B.
        for (let k = 0; k < idx.length - 1; k++) {
          this.solveChainPair(idx[k], idx[k + 1], maxL);
        }
        // Backward sweep — propagates pull from B toward A.
        for (let k = idx.length - 2; k >= 0; k--) {
          this.solveChainPair(idx[k], idx[k + 1], maxL);
        }
      }
    }
  }

  /**
   * Resolve a single chain pair: enforces max-distance via position AND
   * velocity. Velocity correction kills the separating component of the
   * pair's relative motion so continuous outward input force can't slowly
   * leak the chain past its budget — without that, position-only PBD is
   * always slightly elastic.
   *
   * Converging motion (the pair already moving toward each other) is left
   * untouched — only outward separation gets clipped.
   */
  private solveChainPair(i: number, j: number, maxL: number): void {
    const d = sub(this.pos[j], this.pos[i]);
    const len = length(d);
    if (len <= maxL || len < EPS) return;
    const n = scale(d, 1 / len);
    const overlap = len - maxL;
    const wi = this.invMass[i];
    const wj = this.invMass[j];
    const wSum = wi + wj;
    if (wSum < EPS) return;
    // Position correction.
    const corr = overlap / wSum;
    this.pos[i] = add(this.pos[i], scale(n, corr * wj));
    this.pos[j] = sub(this.pos[j], scale(n, corr * wi));
    // Velocity correction along the constraint normal — kill outward only.
    const vRel = dot(sub(this.vel[j], this.vel[i]), n);
    if (vRel > 0) {
      const vCorr = vRel / wSum;
      this.vel[i] = add(this.vel[i], scale(n, vCorr * wj));
      this.vel[j] = sub(this.vel[j], scale(n, vCorr * wi));
    }
  }

  private applyPressure(dt: number): void {
    for (let si = 0; si < this.shapes.length; si++) {
      const sh = this.shapes[si];
      if (sh.isStatic || sh.isTrigger || sh.inactive) continue;
      if (sh.pressureK <= 0) continue;
      const idx = sh.indices;
      if (idx.length < 3) continue;

      const poly = this.buildPolygonFromIndices(idx);
      const area = signedAreaPolygon(poly);
      const target = this.shapePressureTargetArea(si);
      const err = target - area;
      const nIdx = idx.length;

      for (let i = 0; i < nIdx; i++) {
        const ia = idx[i];
        const iprev = idx[(i + nIdx - 1) % nIdx];
        const inext = idx[(i + 1) % nIdx];
        const pprev = this.pos[iprev];
        const pnext = this.pos[inext];
        const grad: Vec2 = { x: (pnext.y - pprev.y) * 0.5, y: (pprev.x - pnext.x) * 0.5 };
        const f = scale(grad, sh.pressureK * err);
        if (this.invMass[ia] > 0) {
          this.vel[ia] = add(this.vel[ia], scale(f, this.invMass[ia] * dt));
        }
      }
    }
  }

  private applyShapeMatching(dt: number): void {
    for (let si = 0; si < this.shapes.length; si++) {
      const sh = this.shapes[si];
      if (sh.isStatic || sh.isTrigger || sh.inactive) continue;
      if (sh.shapeMatchK <= 0) continue;
      const { indices, restLocal, shapeMatchK: smk, shapeMatchDamp: smd } = sh;
      if (indices.length !== restLocal.length) continue;

      let center: Vec2, angle: number;
      if (sh.useFrameOverride) {
        center = { x: sh.frameOverride.tx, y: sh.frameOverride.ty };
        angle = Math.atan2(sh.frameOverride.sin, sh.frameOverride.cos);
      } else {
        // If any hull particles are anchored (invMass=0), they fully define
        // the shape-match frame: locked points sit at their original rest
        // world coordinates by construction, so the best-fit rigid transform
        // mapping rest→current for that subset is exactly the original
        // (worldOrigin, identity) frame. Letting the centroid be the
        // unweighted average of ALL particles makes the frame drift with
        // gravity sag, which then yanks every dynamic neighbor toward the
        // wrong target — producing a visible "smile" right at each anchor.
        // With ≥1 anchor, derive t = mean(pos - restLocal) over anchors and
        // hold angle at 0 (any rest rotation is already baked into restLocal
        // at blob construction time).
        let anchorCount = 0;
        let tx = 0, ty = 0;
        for (let k = 0; k < indices.length; k++) {
          if (this.invMass[indices[k]] === 0) {
            anchorCount++;
            tx += this.pos[indices[k]].x - restLocal[k].x;
            ty += this.pos[indices[k]].y - restLocal[k].y;
          }
        }
        if (anchorCount >= 1) {
          center = { x: tx / anchorCount, y: ty / anchorCount };
          angle = 0;
        } else {
          center = centroidFromIndices(this.pos, indices);
          angle = averageAngle(restLocal, this.pos, indices, center);
        }
      }
      const frame = frameTransform(center, angle);
      const smScale = Math.max(sh.shapeMatchRestScale, 0.05);

      // Center-of-mass velocity
      let vCom: Vec2 = ZERO;
      let mSum = 0;
      for (let k = 0; k < indices.length; k++) {
        const pi = indices[k];
        const m = this.mass[pi];
        vCom = add(vCom, scale(this.vel[pi], m));
        mSum += m;
      }
      if (mSum > 1e-8) vCom = scale(vCom, 1 / mSum);

      for (let k = 0; k < indices.length; k++) {
        const pi = indices[k];
        const target = applyTransform(frame, scale(restLocal[k], smScale));
        const diff = sub(target, this.pos[pi]);
        const vRel = sub(this.vel[pi], vCom);
        const f = sub(scale(diff, smk), scale(vRel, smd));
        if (this.invMass[pi] > 0) {
          this.vel[pi] = add(this.vel[pi], scale(f, this.invMass[pi] * dt));
        }
      }
    }
  }

  private applyHullVelocityDamping(dt: number): void {
    const kh = Math.max(this.hullVertexDampingPerSec, 0);
    const kc = Math.max(this.centerHullDampingPerSec, 0);
    const hFac = Math.exp(-kh * dt);
    const cFac = Math.exp(-kc * dt);
    const skipSpdSq = this.hullDampSkipAboveSpeed * this.hullDampSkipAboveSpeed;

    for (let bi = 0; bi < this.blobRanges.length; bi++) {
      const r = this.blobRanges[bi];
      if (r.inactive) continue;
      const ci = r.start;
      for (let j = r.start; j < r.end; j++) {
        if (j === ci) {
          this.vel[j] = scale(this.vel[j], cFac);
        } else {
          if (lengthSq(this.vel[j]) > skipSpdSq) continue;
          this.vel[j] = scale(this.vel[j], hFac);
        }
      }
    }
  }

  // --- Collisions ---

  private solveCollisions(dt: number): void {
    // Blob-blob first, then blob-static. Both paths are gated by the
    // bitmask layer/mask filter (see physics/layers.ts).
    //
    // Pair iteration sorted by `BlobRange.sortKey` (not raw blob `id`) so
    // host and guest process the same physical pair in the same role
    // order. Raw-id ordering breaks this: host's PM adds host's player
    // first then receives the guest's player_join, guest's PM adds its
    // own first then synthesizes the host's blob from the keyframe, so
    // the local `id`s for the two players are swapped between clients.
    // `collideBlobs(a, b)` is asymmetric (it pushes `a`'s hull first,
    // then `b`'s, against frozen polygons captured before the first
    // push), so swapping the roles produces a small but real position
    // delta — exactly the kind of drift that triggers a visible snap on
    // the next keyframe. Sorting by a stable, level-derived sort key
    // makes the iteration agree on every client.
    const sortedIndices = this.blobRanges
      .map((r, i) => ({ i, key: r.sortKey }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((entry) => entry.i);
    for (let ai = 0; ai < sortedIndices.length; ai++) {
      const a = sortedIndices[ai];
      const ra = this.blobRanges[a];
      if (ra.inactive) continue;
      const sa = this.shapes[ra.shapeIdx];
      if (!sa) continue;
      for (let bi = ai + 1; bi < sortedIndices.length; bi++) {
        const b = sortedIndices[bi];
        const rb = this.blobRanges[b];
        if (rb.inactive) continue;
        const sb = this.shapes[rb.shapeIdx];
        if (!sb) continue;
        if (!canCollide(sa.layer ?? LAYER_BLOB, sa.mask ?? LAYER_ALL,
                        sb.layer ?? LAYER_BLOB, sb.mask ?? LAYER_ALL)) continue;
        this.collideBlobs(a, b);
      }
    }
    for (const surface of this.staticSurfaces) {
      const surfLayer = surface.layer ?? LAYER_WORLD;
      const surfMask = surface.mask ?? LAYER_ALL;
      for (let bi = 0; bi < this.blobRanges.length; bi++) {
        const r = this.blobRanges[bi];
        if (r.inactive) continue;
        const sh = this.shapes[r.shapeIdx];
        if (!sh) continue;
        if (!canCollide(sh.layer ?? LAYER_BLOB, sh.mask ?? LAYER_ALL,
                        surfLayer, surfMask)) continue;
        this.collideBlobWithPoly(bi, surface.poly, true, dt, surface.material, surface.velocity);
      }
    }

  }

  private collideBlobs(aId: number, bId: number): void {
    const ra = this.blobRanges[aId];
    const rb = this.blobRanges[bId];
    const polyA = this.buildPolygonFromIndices(ra.hull);
    const polyB = this.buildPolygonFromIndices(rb.hull);
    if (!aabbOverlap(polygonAABB(polyA), polygonAABB(polyB))) return;

    // Two symmetric passes: A's hull pushed out of B, then B's hull pushed out
    // of A. Both passes are needed for stable resolution under interpenetration
    // — but resolveThreeBodyVelocity inside resolvePointInShape already
    // applies friction reciprocally, so running it on both passes doubles the
    // friction relative to blob-vs-static. Halve the friction scale per pass
    // so the total over both passes is 1x.
    const dt = this.fixedDt / this.substeps;
    for (let k = 0; k < ra.hull.length; k++) {
      this.resolvePointInShape(ra.hull[k], polyB, rb.hull, 0.5, dt);
    }
    for (let k = 0; k < rb.hull.length; k++) {
      this.resolvePointInShape(rb.hull[k], polyA, ra.hull, 0.5, dt);
    }
  }

  /**
   * Push a query particle outside the given polygon (defined by world coords
   * and matching index array). Position correction is mass-weighted between
   * the query particle and the two polygon-edge vertices nearest to it, so
   * anchored vertices (invMass=0) absorb correction without moving.
   *
   * @param frictionScale Scales the friction impulse for this call. Use 1.0
   *   when only one pass runs (the typical case for a single hull-vs-polygon
   *   contact). When `collideBlobs` runs symmetric A-into-B + B-into-A
   *   passes, pass 0.5 to each so the total friction across both passes is
   *   1x and matches blob-vs-static behavior.
   * @param dt Substep duration. When > 0 a gravity-proportional resting-load
   *   floor is added to the Coulomb friction cap so a blob can rest on a
   *   sloped soft platform without sliding off (mirrors the static path's
   *   resting-contact friction).
   */
  private resolvePointInShape(pi: number, polyWorld: Vec2[], polyIndices: number[], frictionScale = 1.0, dt = 0): void {
    const p = this.pos[pi];
    if (!isPointInPolygon(p, polyWorld)) return;

    const info = closestPointOnPolygonBoundary(p, polyWorld);
    let n = negate(info.normal); // flip: interior → push outward
    const closest = info.closest;
    const { wb, wc } = edgeVertexWeights(p, info.a, info.b);

    const edgeI = info.edgeI;
    const ib0 = polyIndices[edgeI];
    const ib1 = polyIndices[(edgeI + 1) % polyIndices.length];

    let pen = dot(sub(p, closest), n);
    if (pen <= 0) pen = this.collisionMargin;

    const invA = this.invMass[pi];
    const invB = this.invMass[ib0];
    const invC = this.invMass[ib1];
    const wSum = invA + invB * wb * wb + invC * wc * wc;
    if (wSum < 1e-8) return;

    const corr = pen / wSum;
    this.pos[pi] = add(this.pos[pi], scale(n, corr * invA));
    this.pos[ib0] = sub(this.pos[ib0], scale(n, corr * invB * wb));
    this.pos[ib1] = sub(this.pos[ib1], scale(n, corr * invC * wc));

    // Resting-load floor — gravity-proportional, only acts on "ground-like"
    // contact normals (support > 0 means the normal opposes gravity).
    let restingLoad = 0;
    if (dt > 0 && this.mass[pi] > EPS) {
      const gL = length(this.gravity);
      if (gL > EPS) {
        const gDir = scale(this.gravity, 1 / gL);
        const upDir = negate(gDir);
        const support = Math.max(0, Math.min(1, dot(upDir, n)));
        restingLoad = this.mass[pi] * gL * support * dt * this.staticFrictionNormalLoadScale;
      }
    }

    const [vaNew, vbNew, vcNew] = resolveThreeBodyVelocity(
      this.vel[pi], this.mass[pi],
      this.vel[ib0], this.mass[ib0],
      this.vel[ib1], this.mass[ib1],
      n, wb, wc,
      this.collisionRestitution,
      this.blobBlobFrictionMu * frictionScale,
      info.edgeDir,
      this.blobBlobFrictionImpulseScale * frictionScale,
      restingLoad,
    );
    this.vel[pi] = vaNew;
    this.vel[ib0] = vbNew;
    this.vel[ib1] = vcNew;
  }

  private collideBlobWithPoly(blobId: number, polyWorld: Vec2[], polyIsStatic: boolean, contactDt: number, material: SurfaceMaterial = 'default', surfaceVel?: Vec2): void {
    const matParams = MATERIAL_PARAMS[material];
    const restitution = polyIsStatic ? matParams.restitution : this.staticRestitution;
    const frictionMu = polyIsStatic ? matParams.frictionMu : this.staticEdgeFrictionMu;
    const r = this.blobRanges[blobId];
    const hull = r.hull;
    const bbox = polygonAABB(polyWorld);
    const hasSurfVel = surfaceVel !== undefined && (surfaceVel.x !== 0 || surfaceVel.y !== 0);
    const sv: Vec2 = hasSurfVel ? surfaceVel! : ZERO;

    for (let k = 0; k < hull.length; k++) {
      const pi = hull[k];
      const p = this.pos[pi];
      // Quick AABB check for the point
      const pr: AABB = { minX: p.x - 2, minY: p.y - 2, maxX: p.x + 2, maxY: p.y + 2 };
      if (!aabbOverlap(pr, bbox)) continue;

      const info = closestPointOnPolygonBoundary(p, polyWorld);
      const nBase = info.normal;
      const closest = info.closest;
      const inside = isPointInPolygon(p, polyWorld);
      const distB = distanceTo(p, closest);

      let n: Vec2;
      let pushDist: number;
      let useStatic = false;

      if (inside) {
        n = negate(nBase);
        let pen = dot(sub(p, closest), n);
        if (pen <= 0) pen = this.collisionMargin;
        pushDist = pen + this.collisionMargin;
        useStatic = polyIsStatic;
      } else if (polyIsStatic && distB <= this.staticContactSlop) {
        const toPt = sub(p, closest);
        if (dot(toPt, nBase) < -0.05) continue;
        n = nBase;
        const gap = dot(toPt, n);
        if (gap < 0) continue;
        pushDist = Math.max(gap, this.collisionMargin) + this.collisionMargin * 0.25;
        useStatic = true;
      } else {
        continue;
      }

      if (polyIsStatic && useStatic) {
        // Track ground contacts (contact with upward-facing normal)
        if (n.y < -0.3) {
          this.blobGroundContacts[blobId]++;
          // Capture the most upward-facing contact this step. Prefer the
          // contact whose normal is closest to "straight up" (most negative
          // n.y) so splats land on the flattest part of the surface the
          // blob actually settled on, not on an incidental side touch.
          const existing = this.blobGroundContactNormal[blobId];
          if (!existing || n.y < existing.y) {
            this.blobGroundContactPoint[blobId] = { x: closest.x, y: closest.y };
            this.blobGroundContactNormal[blobId] = { x: n.x, y: n.y };
            this.blobGroundContactPoly[blobId] = polyWorld;
          }
        }

        // Capture any-surface contact (walls/ceilings too) for splat VFX.
        // First contact wins for the step.
        if (this.blobImpactContactPoint[blobId] === null) {
          this.blobImpactContactPoint[blobId] = { x: closest.x, y: closest.y };
          this.blobImpactContactNormal[blobId] = { x: n.x, y: n.y };
          this.blobImpactContactPoly[blobId] = polyWorld;
        }

        // Track sticky contacts (accumulate count + normal for averaging on read)
        if (material === 'sticky') {
          this.blobStickyContactCount[blobId]++;
          const sum = this.blobStickyContactNormalSum[blobId];
          sum.x += n.x;
          sum.y += n.y;
        }

        // Remove velocity into wall (work in surface frame for kinematic surfaces)
        const vRel0 = hasSurfVel ? sub(this.vel[pi], sv) : this.vel[pi];
        const vnInWall = dot(vRel0, n);
        if (vnInWall < 0) {
          this.vel[pi] = sub(this.vel[pi], scale(n, vnInWall));
        }

        // Position correction (skip anchored particles — they don't move)
        if (this.invMass[pi] > 0) {
          this.pos[pi] = add(closest, scale(n, pushDist));
        }

        // Restitution (surface-frame normal component)
        const vRel1 = hasSurfVel ? sub(this.vel[pi], sv) : this.vel[pi];
        const vnBeforeRest = dot(vRel1, n);
        if (vnBeforeRest < 0) {
          this.vel[pi] = sub(this.vel[pi], scale(n, vnBeforeRest * (1 + restitution)));
        }
        const vRel2 = hasSurfVel ? sub(this.vel[pi], sv) : this.vel[pi];
        const vnAfterRest = dot(vRel2, n);

        // Static friction
        if (frictionMu > 1e-6) {
          const edgeDir = info.edgeDir;
          let t = normalize(edgeDir);
          if (lengthSq(t) < 1e-12) t = normalize({ x: -n.y, y: n.x });

          const vRelT = hasSurfVel ? sub(this.vel[pi], sv) : this.vel[pi];
          const vT = dot(vRelT, t);
          if (Math.abs(vT) >= this.staticFrictionMinTangSpeed) {
            const jnCollision = Math.abs(this.mass[pi] * (vnAfterRest - vnBeforeRest));
            const gL = length(this.gravity);
            const gDir = gL > 1e-6 ? scale(this.gravity, 1 / gL) : vec2(0, 1);
            const upDir = negate(gDir);
            const support = Math.max(0, Math.min(1, dot(upDir, n)));
            const jnRest = this.mass[pi] * gL * support * contactDt * this.staticFrictionNormalLoadScale;
            const jn = Math.max(jnCollision, jnRest);
            const jtUncap = -this.mass[pi] * vT;
            const jt = Math.max(-frictionMu * jn, Math.min(frictionMu * jn, jtUncap));
            this.vel[pi] = add(this.vel[pi], scale(t, jt / this.mass[pi]));
          }
        }
      }
    }
  }

  /**
   * CCD sweep: for each hull particle, ray-cast its motion segment against
   * all static polygon edges. If the particle tunneled through geometry,
   * clamp it to the earliest intersection point and remove velocity into wall.
   */
  private sweepStaticCCD(prevPos: Vec2[]): void {
    for (let bi = 0; bi < this.blobRanges.length; bi++) {
      const r = this.blobRanges[bi];
      if (r.inactive) continue;
      // Sweep hull particles and center particle
      const centerIdx = this.shapes[r.shapeIdx]?.centerIdx ?? -1;
      const indicesToCheck = centerIdx >= 0 ? [...r.hull, centerIdx] : r.hull;
      for (const pi of indicesToCheck) {
        const oldP = prevPos[pi];
        const newP = this.pos[pi];
        // Skip if barely moved
        const dx = newP.x - oldP.x;
        const dy = newP.y - oldP.y;
        if (dx * dx + dy * dy < 1e-4) continue;

        let bestT = Infinity;
        let bestPoint: Vec2 | null = null;
        let bestNormal: Vec2 | null = null;
        let bestSurfVel: Vec2 | undefined = undefined;

        for (const surface of this.staticSurfaces) {
          const poly = surface.poly;
          const pn = poly.length;
          for (let e = 0; e < pn; e++) {
            const a = poly[e];
            const b = poly[(e + 1) % pn];
            const hit = segmentIntersectionT(oldP, newP, a, b);
            if (hit && hit.t < bestT) {
              bestT = hit.t;
              bestPoint = hit.point;
              // Edge normal: perpendicular to edge, pointing outward
              const edgeX = b.x - a.x;
              const edgeY = b.y - a.y;
              const len = Math.sqrt(edgeX * edgeX + edgeY * edgeY);
              if (len < 1e-10) continue;
              // Normal candidates: (-edgeY, edgeX) or (edgeY, -edgeX)
              // Pick the one pointing from the edge toward oldP (the side we came from)
              let nx = -edgeY / len;
              let ny = edgeX / len;
              const toOld = (oldP.x - a.x) * nx + (oldP.y - a.y) * ny;
              if (toOld < 0) { nx = -nx; ny = -ny; }
              bestNormal = vec2(nx, ny);
              bestSurfVel = surface.velocity;
            }
          }
        }

        if (bestPoint && bestNormal && this.invMass[pi] > 0) {
          // Place particle at hit point + margin along the outward normal
          this.pos[pi] = add(bestPoint, scale(bestNormal, this.collisionMargin));
          // Remove velocity component into the wall (surface frame for kinematic surfaces)
          const hasSv = bestSurfVel !== undefined && (bestSurfVel.x !== 0 || bestSurfVel.y !== 0);
          const vRel = hasSv ? sub(this.vel[pi], bestSurfVel!) : this.vel[pi];
          const vn = dot(vRel, bestNormal);
          if (vn < 0) {
            this.vel[pi] = sub(this.vel[pi], scale(bestNormal, vn));
          }
        }
      }
    }
  }

  /**
   * Blob-vs-blob CCD: for each hull particle whose motion segment over the
   * substep crosses an edge of another blob's *previous* hull, clamp the
   * particle to the entry point + margin along the outward edge normal and
   * exchange momentum with the two edge vertices via the same three-body
   * impulse resolver the discrete path uses. "Previous" hulls are taken from
   * `prevPos` (the snapshot saved before integration this substep) so the
   * sweep is symmetric — A's particles are tested against B's prev hull and
   * vice-versa — and stable even when both blobs are moving.
   *
   * Why three-body impulse (not just zeroing the particle's inward velocity):
   * a fast incoming particle carries momentum that *must* be transferred to
   * the target blob's edge vertices, otherwise the target blob never gets
   * pushed and high-speed collisions feel like dead-cat hits. The discrete
   * resolver in `collideBlobs` does this via `resolveThreeBodyVelocity`; the
   * CCD path mirrors it, with friction halved per pass since ordered pairs
   * (a,b) and (b,a) both fire — matching the discrete code's halving rule.
   *
   * This pass exists because the discrete blob-vs-blob resolver picks a
   * contact edge using `closestPointOnPolygonBoundary`: under deep
   * penetration (>~half a blob), the nearest edge is the *far* side, and the
   * resolver pushes the particle through instead of back out, leaving the
   * blobs centroid-merged.
   */
  private sweepBlobCCD(prevPos: Vec2[]): void {
    const nBlobs = this.blobRanges.length;
    for (let a = 0; a < nBlobs; a++) {
      const ra = this.blobRanges[a];
      if (ra.inactive) continue;
      const sa = this.shapes[ra.shapeIdx];
      if (!sa) continue;
      for (let b = 0; b < nBlobs; b++) {
        if (a === b) continue;
        const rb = this.blobRanges[b];
        if (rb.inactive) continue;
        const sb = this.shapes[rb.shapeIdx];
        if (!sb) continue;
        if (!canCollide(sa.layer ?? LAYER_BLOB, sa.mask ?? LAYER_ALL,
                        sb.layer ?? LAYER_BLOB, sb.mask ?? LAYER_ALL)) continue;

        const pn = rb.hull.length;
        if (pn < 3) continue;
        // B's previous hull polygon = the swept-from reference for A's particles.
        const polyBPrev: Vec2[] = new Array(pn);
        for (let k = 0; k < pn; k++) polyBPrev[k] = prevPos[rb.hull[k]];

        for (const pi of ra.hull) {
          if (this.invMass[pi] === 0) continue;
          const oldP = prevPos[pi];
          const newP = this.pos[pi];
          const dx = newP.x - oldP.x;
          const dy = newP.y - oldP.y;
          if (dx * dx + dy * dy < 1e-4) continue;

          let bestT = Infinity;
          let bestPoint: Vec2 | null = null;
          let bestNormal: Vec2 | null = null;
          let bestEdge = -1;
          let bestEdgeDir: Vec2 = ZERO;

          for (let e = 0; e < pn; e++) {
            const ea = polyBPrev[e];
            const eb = polyBPrev[(e + 1) % pn];
            const hit = segmentIntersectionT(oldP, newP, ea, eb);
            if (!hit || hit.t >= bestT) continue;
            const edgeX = eb.x - ea.x;
            const edgeY = eb.y - ea.y;
            const elen = Math.sqrt(edgeX * edgeX + edgeY * edgeY);
            if (elen < 1e-10) continue;
            // Outward normal points from the edge toward oldP (the side we came from).
            let nx = -edgeY / elen;
            let ny = edgeX / elen;
            const toOld = (oldP.x - ea.x) * nx + (oldP.y - ea.y) * ny;
            if (toOld < 0) { nx = -nx; ny = -ny; }
            bestT = hit.t;
            bestPoint = hit.point;
            bestNormal = vec2(nx, ny);
            bestEdge = e;
            bestEdgeDir = vec2(edgeX / elen, edgeY / elen);
          }

          if (!bestPoint || !bestNormal || bestEdge < 0) continue;

          // Position correction: clamp particle to entry + margin, just outside
          // the swept-from edge.
          this.pos[pi] = add(bestPoint, scale(bestNormal, this.collisionMargin));

          // Velocity-level impulse exchange with the two edge vertices of B.
          const ib0 = rb.hull[bestEdge];
          const ib1 = rb.hull[(bestEdge + 1) % pn];
          const eA = polyBPrev[bestEdge];
          const eB = polyBPrev[(bestEdge + 1) % pn];
          const { wb, wc } = edgeVertexWeights(bestPoint, eA, eB);

          const [vaNew, vbNew, vcNew] = resolveThreeBodyVelocity(
            this.vel[pi], this.mass[pi],
            this.vel[ib0], this.mass[ib0],
            this.vel[ib1], this.mass[ib1],
            bestNormal, wb, wc,
            this.collisionRestitution,
            this.blobBlobFrictionMu * 0.5,
            bestEdgeDir,
            this.blobBlobFrictionImpulseScale * 0.5,
            0,
          );
          this.vel[pi] = vaNew;
          this.vel[ib0] = vbNew;
          this.vel[ib1] = vcNew;
        }
      }
    }
  }

  private solveParticleCollisions(_dt: number): void {
    for (let i = 0; i < this.pos.length; i++) {
      const rad = this.particleRadius[i];
      if (rad <= 0) continue;

      const pLayer = this.particleLayer[i] ?? LAYER_DEFAULT;
      const pMask = this.particleMask[i] ?? LAYER_ALL;

      for (const surface of this.staticSurfaces) {
        const sLayer = surface.layer ?? LAYER_WORLD;
        const sMask = surface.mask ?? LAYER_ALL;
        if (!canCollide(pLayer, pMask, sLayer, sMask)) continue;
        this.resolveParticleVsPoly(i, rad, surface.poly);
      }
      for (const sh of this.shapes) {
        if (sh.isTrigger || sh.inactive) continue;
        const shLayer = sh.layer ?? LAYER_BLOB;
        const shMask = sh.mask ?? LAYER_ALL;
        if (!canCollide(pLayer, pMask, shLayer, shMask)) continue;
        if (sh.isStatic) {
          if (sh.staticPoly.length > 0) this.resolveParticleVsPoly(i, rad, sh.staticPoly);
        } else {
          if (sh.indices.length >= 2) {
            const poly = this.buildPolygonFromIndices(sh.indices);
            this.resolveParticleVsPoly(i, rad, poly);
          }
        }
      }
    }
  }

  private resolveParticleVsPoly(i: number, rad: number, polyWorld: Vec2[]): void {
    // Anchored particles (invMass=0) are immovable — never push them.
    if (this.invMass[i] === 0) return;
    const p = this.pos[i];
    const info = closestPointOnPolygonBoundary(p, polyWorld);
    const closest = info.closest;
    const n = info.normal;
    const inside = isPointInPolygon(p, polyWorld);
    const distAlong = dot(sub(p, closest), n);

    if (!inside) {
      if (distAlong >= rad - this.collisionMargin * 0.25) return;
      this.pos[i] = add(p, scale(n, rad - distAlong));
    } else {
      this.pos[i] = add(closest, scale(n, rad + this.collisionMargin));
    }

    const vn = dot(this.vel[i], n);
    if (vn < 0) {
      this.vel[i] = sub(this.vel[i], scale(n, vn * (1 + this.collisionRestitution)));
    }
  }

  private processTriggerEvents(): void {
    for (let si = 0; si < this.shapes.length; si++) {
      const sh = this.shapes[si];
      if (!sh.isTrigger) continue;
      if (sh.staticPoly.length === 0) continue;
      const bbox = polygonAABB(sh.staticPoly);

      for (let bi = 0; bi < this.blobRanges.length; bi++) {
        const range = this.blobRanges[bi];
        if (range.inactive) continue;
        // Trigger fires if ANY hull point (or the center) is inside the
        // trigger polygon. AABB prefilter keeps the inner loop cheap.
        let inside = false;
        for (const idx of range.hull) {
          const p = this.pos[idx];
          if (p.x < bbox.minX || p.x > bbox.maxX || p.y < bbox.minY || p.y > bbox.maxY) continue;
          if (isPointInPolygon(p, sh.staticPoly)) { inside = true; break; }
        }
        if (!inside) {
          const c = this.pos[range.start];
          if (c.x >= bbox.minX && c.x <= bbox.maxX && c.y >= bbox.minY && c.y <= bbox.maxY) {
            if (isPointInPolygon(c, sh.staticPoly)) inside = true;
          }
        }
        const key = `${si}_${bi}`;
        const prev = this.triggerPrev.get(key) ?? false;

        if (inside && !prev) {
          this.onTriggerEntered?.(si, bi);
        } else if (!inside && prev) {
          this.onTriggerExited?.(si, bi);
        }
        this.triggerPrev.set(key, inside);
      }
    }
  }

  // --- Helpers ---

  private shapePressureTargetArea(shapeIdx: number): number {
    if (shapeIdx < 0 || shapeIdx >= this.shapes.length) return 0;
    const sh = this.shapes[shapeIdx];
    const baseT = sh.targetRestArea;
    const sc = Math.max(sh.shapeMatchRestScale, 0.05);
    return Math.max(baseT * sc * sc, 1e-6);
  }

  private blobPumpPressureMultiplier(blobId: number): number {
    const r = this.blobRanges[blobId];
    const si = r.shapeIdx;
    if (si < 0 || si >= this.shapes.length) return 1;
    const sh = this.shapes[si];
    const pk = sh.pressureK;
    const idx = sh.indices;
    if (idx.length < 3) return 1;
    const poly = this.buildPolygonFromIndices(idx);
    const area = signedAreaPolygon(poly);
    const target = this.shapePressureTargetArea(si);
    const err = Math.abs(target - area);
    const denom = Math.max(Math.abs(target), 1);
    return 1 + pk * err / denom;
  }

  buildPolygonFromIndices(indices: number[]): Vec2[] {
    return indices.map(i => this.pos[i]);
  }

  // ---------------------------------------------------------------
  // SoftBodyEngine surface adapters.
  //
  // Most of the interface is already satisfied by methods defined
  // above. These additions either expose properties as method calls
  // (so the wasm-backed wrapper can mirror them) or provide stubs
  // for interface methods that don't apply to the TS sim.
  // ---------------------------------------------------------------

  /** Return blob's contiguous particle range + hull indices. */
  getBlobRange(blobId: number): { start: number; end: number; hull: readonly number[] } | null {
    if (blobId < 0 || blobId >= this.blobRanges.length) return null;
    const r = this.blobRanges[blobId];
    return { start: r.start, end: r.end, hull: r.hull };
  }

  /** Snapshot of static surfaces (returns the live array — TS sim only;
   *  the Rust engine returns a fresh copy each call). */
  getStaticSurfacesSnapshot(): readonly StaticSurface[] {
    return this.staticSurfaces;
  }

  /** Snapshot of shapes, optionally filtering out triggers. */
  getShapesSnapshot(includeTriggers = true): readonly Shape[] {
    if (includeTriggers) return this.shapes;
    return this.shapes.filter(s => !s.isTrigger);
  }

  /** Push a level-author extra spring (not owned by any blob). */
  addExtraSpring(i: number, j: number, rest: number, k: number, damp: number): void {
    this.extraSprings.push([i, j, rest, k, damp]);
  }

  /** Pull a particle toward a fixed world-position with k/damp. */
  addHomeAnchor(idx: number, home: Vec2, k: number, damp: number): void {
    this.homeAnchors.push({ idx, home: { x: home.x, y: home.y }, k, damp });
  }

  /** State hash — TS sim is non-deterministic across browsers, so this
   *  is intentionally a stub. The Rust engine returns a real FNV-1a hash. */
  stateHash(): string { return ''; }

  /** Reset the RNG seed. Mirrors the wasm engine's `setRngSeed` for the
   *  SoftBodyEngine contract. */
  setRngSeed(seed: number): void { this.rng = createRng((seed >>> 0) || 1); }

  /** Per-particle position write (replaces direct `world.pos[i] = ...`). */
  setParticlePos(i: number, x: number, y: number): void {
    if (i < 0 || i >= this.pos.length) return;
    this.pos[i] = { x, y };
  }
  /** Per-particle velocity write. */
  setParticleVel(i: number, x: number, y: number): void {
    if (i < 0 || i >= this.vel.length) return;
    this.vel[i] = { x, y };
  }
  /** Override the logical tick counter (netcode keyframe restore). */
  setTick(t: number): void { this.tick = t; }

  /** Snapshot/restore stubs — rollback netcode runs on the wasm engine
   *  only (TS sim's float ops aren't bit-deterministic across browsers
   *  so rollback replay wouldn't reproduce the original state). */
  serializeState(): Uint8Array { return new Uint8Array(); }
  restoreState(_buf: Uint8Array): boolean { return false; }

  /** Cheap particle-count read (avoids allocations in rollback hot path). */
  particleCount(): number { return this.pos.length; }

  /** SoftBodyEngine contract — no-op on the TS sim because the JS-side
   *  `StaticSurface` object IS the same reference the engine reads, so
   *  any mutation to `.poly` / `.velocity` is already visible. The
   *  wasm-backed engine needs an explicit sync (see softBodyWorldRust.ts). */
  commitStaticSurface(_surface: StaticSurface): void { /* no-op */ }

  /** Logical tick getter mirroring the Rust engine's interface property. */
  // (already exposed as `tick: number` field above.)
}

// --- Utility: segment intersection ---

function segmentIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const d1 = sub(p2, p1);
  const d2 = sub(p4, p3);
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-10) return null;

  const d3 = sub(p3, p1);
  const t = (d3.x * d2.y - d3.y * d2.x) / cross;
  const u = (d3.x * d1.y - d3.y * d1.x) / cross;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return add(p1, scale(d1, t));
  }
  return null;
}

/** Segment intersection returning parametric t on first segment + hit point. */
function segmentIntersectionT(
  p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2,
): { t: number; point: Vec2 } | null {
  const d1 = sub(p2, p1);
  const d2 = sub(p4, p3);
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-10) return null;

  const d3 = sub(p3, p1);
  const t = (d3.x * d2.y - d3.y * d2.x) / cross;
  const u = (d3.x * d1.y - d3.y * d1.x) / cross;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { t, point: add(p1, scale(d1, t)) };
  }
  return null;
}
