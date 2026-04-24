import { Vec2, vec2, add, sub, scale, dot, length, lengthSq, normalize, negate, distanceTo, ZERO, RIGHT } from './vec2';
import { Spring, BlobRange, Shape, Transform2D, BlobResult, PumpEdge, RayHit, AABB } from './types';
import {
  polygonAABB, aabbOverlap, isPointInPolygon,
  closestPointOnPolygonBoundary, edgeVertexWeights,
  signedAreaPolygon, resolveThreeBodyVelocity,
} from './collision';
import { solveWeld, solveWeightedAnchor, solveDistanceMax } from './constraints';
import { centroidFromIndices, averageAngle, frameTransform, applyTransform } from './shapeMatching';

const EPS = 1e-6;

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
}

export class SoftBodyWorld {
  // Particle arrays
  pos: Vec2[] = [];
  vel: Vec2[] = [];
  mass: number[] = [];
  invMass: number[] = [];
  particleRadius: number[] = [];

  // Springs
  springs: Spring[] = [];

  // Shapes & blobs
  shapes: Shape[] = [];
  blobRanges: BlobRange[] = [];

  // Static collision geometry
  staticPolygons: Vec2[][] = [];

  // Constraints
  private welds: [number, number][] = [];
  private anchors: { indicesA: number[]; weightsA: number[]; indicesB: number[]; weightsB: number[] }[] = [];
  private distanceMaxConstraints: [number, number, number][] = [];

  // Trigger state
  private triggerPrev: Map<string, boolean> = new Map();

  // Ground contact tracking — reset each step, counts hull particles touching static geometry
  private blobGroundContacts: number[] = [];

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

  // Callbacks
  onTriggerEntered?: (triggerShapeIdx: number, blobId: number) => void;
  onTriggerExited?: (triggerShapeIdx: number, blobId: number) => void;

  constructor(config: SoftBodyWorldConfig = {}) {
    this.gravityScale = config.gravityScale ?? 4.0;
    this.gravity = config.gravity ?? vec2(0, 980.0 * this.gravityScale);
    this.fixedDt = config.fixedDt ?? 1 / 60;
    this.substeps = config.substeps ?? 2;
    this.collisionMargin = config.collisionMargin ?? 1.5;
    this.collisionRestitution = config.collisionRestitution ?? 0.25;
    this.constraintIters = config.constraintIters ?? 8;
    this.staticRestitution = config.staticRestitution ?? 0.0;
    this.staticContactSlop = config.staticContactSlop ?? 14.0;
    this.blobBlobFrictionMu = config.blobBlobFrictionMu ?? 1.44;
    this.blobBlobFrictionImpulseScale = config.blobBlobFrictionImpulseScale ?? 1.0;
    this.staticEdgeFrictionMu = config.staticEdgeFrictionMu ?? 1.64;
    this.staticFrictionMinTangSpeed = config.staticFrictionMinTangSpeed ?? 0.06;
    this.staticFrictionNormalLoadScale = config.staticFrictionNormalLoadScale ?? 2.0;
    this.hullVertexDampingPerSec = config.hullVertexDampingPerSec ?? 0.012;
    this.centerHullDampingPerSec = config.centerHullDampingPerSec ?? 0.004;
    this.hullDampSkipAboveSpeed = config.hullDampSkipAboveSpeed ?? 220.0;
  }

  // --- Public API ---

  registerStaticPolygon(poly: Vec2[]): void {
    this.staticPolygons.push([...poly]);
  }

  clearStaticPolygons(): void {
    this.staticPolygons.length = 0;
  }

  registerTriggerPolygon(poly: Vec2[], gravityOverride: Vec2 = ZERO): number {
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
      triggerGravity: gravityOverride,
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
  }): BlobResult {
    const {
      hullRestLocal, centerLocal = ZERO,
      centerMass, hullMass, springK, springDamp,
      radialK, radialDamp, pressureK, shapeMatchK, shapeMatchDamp,
      worldOrigin,
    } = params;

    const numHull = hullRestLocal.length;
    if (numHull < 3) throw new Error('Need at least 3 hull points');

    const start = this.pos.length;

    // Center particle
    this.pos.push(add(centerLocal, worldOrigin));
    this.vel.push(ZERO);
    this.mass.push(centerMass);
    this.invMass.push(centerMass > 0.001 ? 1 / centerMass : 0);
    this.particleRadius.push(0);

    // Hull particles
    const hullIndices: number[] = [];
    for (let i = 0; i < numHull; i++) {
      this.pos.push(add(hullRestLocal[i], worldOrigin));
      this.vel.push(ZERO);
      this.mass.push(hullMass);
      this.invMass.push(hullMass > 0.001 ? 1 / hullMass : 0);
      this.particleRadius.push(0);
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
      useFrameOverride: false,
      frameOverride: { cos: 1, sin: 0, tx: 0, ty: 0 },
      triggerGravity: ZERO,
      centerIdx: start,
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
    });

    return { blobId, centerIdx: start, hullIndices, shapeIdx };
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

  applyBlobMoveForce(blobId: number, move: Vec2, force: number): void {
    if (blobId < 0 || blobId >= this.blobRanges.length) return;
    const r = this.blobRanges[blobId];
    const f = scale(move, force);
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

  addWeightedAnchor(indicesA: number[], weightsA: number[], indicesB: number[], weightsB: number[]): void {
    this.anchors.push({ indicesA, weightsA, indicesB, weightsB });
  }

  clearSimulation(): void {
    this.pos.length = 0;
    this.vel.length = 0;
    this.mass.length = 0;
    this.invMass.length = 0;
    this.particleRadius.length = 0;
    this.springs.length = 0;
    this.shapes = this.shapes.filter(sh => sh.isTrigger);
    this.blobRanges.length = 0;
    this.welds.length = 0;
    this.anchors.length = 0;
    this.distanceMaxConstraints.length = 0;
    this.triggerPrev.clear();
    this.timeAccum = 0;
  }

  rayCast(origin: Vec2, dir: Vec2, maxDist: number): RayHit {
    const d = normalize(dir);
    const end = add(origin, scale(d, maxDist));
    let bestT = Infinity;
    let bestNormal: Vec2 = { x: 0, y: -1 };
    let hit = false;

    for (const poly of this.staticPolygons) {
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
    this.timeAccum += delta;
    while (this.timeAccum >= this.fixedDt) {
      this.timeAccum -= this.fixedDt;
      for (let s = 0; s < this.substeps; s++) {
        this.substep();
      }
    }
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
      const cx = centroidFromIndices(this.pos, r.hull);
      for (let si = 0; si < this.shapes.length; si++) {
        const sh = this.shapes[si];
        if (!sh.isTrigger) continue;
        if (sh.staticPoly.length === 0) continue;
        if (isPointInPolygon(cx, sh.staticPoly)) {
          if (lengthSq(sh.triggerGravity) > 0.0001) {
            for (let j = r.start; j < r.end; j++) {
              grav[j] = sh.triggerGravity;
            }
          }
        }
      }
    }

    // 2. Apply gravity
    for (let i = 0; i < n; i++) {
      this.vel[i] = add(this.vel[i], scale(grav[i], dt));
    }

    // 3-5. Forces
    this.applySprings(dt);
    this.applyPressure(dt);
    this.applyShapeMatching(dt);

    // 6. Semi-implicit Euler — save prev positions for CCD sweep
    const prevPos: Vec2[] = new Array(n);
    for (let i = 0; i < n; i++) {
      prevPos[i] = this.pos[i];
      this.pos[i] = add(this.pos[i], scale(this.vel[i], dt));
    }

    // 6b. CCD sweep: detect and resolve tunneling through static geometry
    this.sweepStaticCCD(prevPos);

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

    // 8-9. Collisions — reset ground contact counts
    this.blobGroundContacts.length = this.blobRanges.length;
    this.blobGroundContacts.fill(0);
    this.solveCollisions(dt);
    this.solveParticleCollisions(dt);

    // 10. Triggers
    this.processTriggerEvents();

    // 11. Damping
    this.applyHullVelocityDamping(dt);
  }

  // --- Internal physics ---

  private applySprings(dt: number): void {
    for (let bi = 0; bi < this.blobRanges.length; bi++) {
      const r = this.blobRanges[bi];
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
  }

  private applyPressure(dt: number): void {
    for (let si = 0; si < this.shapes.length; si++) {
      const sh = this.shapes[si];
      if (sh.isStatic || sh.isTrigger) continue;
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
      if (sh.isStatic || sh.isTrigger) continue;
      if (sh.shapeMatchK <= 0) continue;
      const { indices, restLocal, shapeMatchK: smk, shapeMatchDamp: smd } = sh;
      if (indices.length !== restLocal.length) continue;

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
    // Blob-blob first, then blob-static
    for (let a = 0; a < this.blobRanges.length; a++) {
      for (let b = a + 1; b < this.blobRanges.length; b++) {
        this.collideBlobs(a, b);
      }
    }
    for (const poly of this.staticPolygons) {
      for (let bi = 0; bi < this.blobRanges.length; bi++) {
        this.collideBlobWithPoly(bi, poly, true, dt);
      }
    }
  }

  private collideBlobs(aId: number, bId: number): void {
    const ra = this.blobRanges[aId];
    const rb = this.blobRanges[bId];
    const polyA = this.buildPolygonFromIndices(ra.hull);
    const polyB = this.buildPolygonFromIndices(rb.hull);
    if (!aabbOverlap(polygonAABB(polyA), polygonAABB(polyB))) return;

    for (let k = 0; k < ra.hull.length; k++) {
      this.resolvePointInShape(ra.hull[k], polyB, rb.hull);
    }
    for (let k = 0; k < rb.hull.length; k++) {
      this.resolvePointInShape(rb.hull[k], polyA, ra.hull);
    }
  }

  private resolvePointInShape(pi: number, polyWorld: Vec2[], polyIndices: number[]): void {
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

    const [vaNew, vbNew, vcNew] = resolveThreeBodyVelocity(
      this.vel[pi], this.mass[pi],
      this.vel[ib0], this.mass[ib0],
      this.vel[ib1], this.mass[ib1],
      n, wb, wc,
      this.collisionRestitution,
      this.blobBlobFrictionMu,
      info.edgeDir,
      this.blobBlobFrictionImpulseScale,
    );
    this.vel[pi] = vaNew;
    this.vel[ib0] = vbNew;
    this.vel[ib1] = vcNew;
  }

  private collideBlobWithPoly(blobId: number, polyWorld: Vec2[], polyIsStatic: boolean, contactDt: number): void {
    const r = this.blobRanges[blobId];
    const hull = r.hull;
    const bbox = polygonAABB(polyWorld);

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
        }

        // Remove velocity into wall
        const vnInWall = dot(this.vel[pi], n);
        if (vnInWall < 0) {
          this.vel[pi] = sub(this.vel[pi], scale(n, vnInWall));
        }

        // Position correction
        this.pos[pi] = add(closest, scale(n, pushDist));

        // Restitution
        const vnBeforeRest = dot(this.vel[pi], n);
        if (vnBeforeRest < 0) {
          this.vel[pi] = sub(this.vel[pi], scale(n, vnBeforeRest * (1 + this.staticRestitution)));
        }
        const vnAfterRest = dot(this.vel[pi], n);

        // Static friction
        if (this.staticEdgeFrictionMu > 1e-6) {
          const edgeDir = info.edgeDir;
          let t = normalize(edgeDir);
          if (lengthSq(t) < 1e-12) t = normalize({ x: -n.y, y: n.x });

          const vT = dot(this.vel[pi], t);
          if (Math.abs(vT) >= this.staticFrictionMinTangSpeed) {
            const jnCollision = Math.abs(this.mass[pi] * (vnAfterRest - vnBeforeRest));
            const gL = length(this.gravity);
            const gDir = gL > 1e-6 ? scale(this.gravity, 1 / gL) : vec2(0, 1);
            const upDir = negate(gDir);
            const support = Math.max(0, Math.min(1, dot(upDir, n)));
            const jnRest = this.mass[pi] * gL * support * contactDt * this.staticFrictionNormalLoadScale;
            const jn = Math.max(jnCollision, jnRest);
            const jtUncap = -this.mass[pi] * vT;
            const jt = Math.max(-this.staticEdgeFrictionMu * jn, Math.min(this.staticEdgeFrictionMu * jn, jtUncap));
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

        for (const poly of this.staticPolygons) {
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
            }
          }
        }

        if (bestPoint && bestNormal) {
          // Place particle at hit point + margin along the outward normal
          this.pos[pi] = add(bestPoint, scale(bestNormal, this.collisionMargin));
          // Remove velocity component into the wall
          const vn = dot(this.vel[pi], bestNormal);
          if (vn < 0) {
            this.vel[pi] = sub(this.vel[pi], scale(bestNormal, vn));
          }
        }
      }
    }
  }

  private solveParticleCollisions(_dt: number): void {
    for (let i = 0; i < this.pos.length; i++) {
      const rad = this.particleRadius[i];
      if (rad <= 0) continue;

      for (const poly of this.staticPolygons) {
        this.resolveParticleVsPoly(i, rad, poly);
      }
      for (const sh of this.shapes) {
        if (sh.isTrigger) continue;
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

      for (let bi = 0; bi < this.blobRanges.length; bi++) {
        const cx = centroidFromIndices(this.pos, this.blobRanges[bi].hull);
        const inside = isPointInPolygon(cx, sh.staticPoly);
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
