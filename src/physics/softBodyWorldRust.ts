// SoftBodyEngine implementation backed by the wasm-compiled Rust sim.
//
// Architecture:
//   - JS-side state: trigger callbacks, logic gate, post-tick hook,
//     static-surface object → index map (TS sim addresses surfaces by
//     reference; wasm by index, so we keep a mapping).
//   - Each `step()` call:
//       1. Run logic gate; bail if false
//       2. wasm.step(dt)
//       3. Drain trigger enter/exit events; fire callbacks
//       4. Fire post-tick hook
//   - Per-frame getters (`getPositions`, etc.) materialize fresh
//     Vec2[] from the wasm typed arrays. Renderer-side cost.
//
// All numeric inputs go through the wasm boundary as f64; the wasm
// side rounds to Fx via `Fx::from_f64` (canonical round-half-to-even).

import type {
  AddBlobFromHullParams, EngineRng, GroundContact, RopeChainOpts,
  RopeChainResult, SoftBodyEngine, StickyContact,
} from './SoftBodyEngine';
import {
  BlobRange, BlobResult, GravityField, Shape, StaticSurface,
  SurfaceMaterial,
} from './types';
import { Vec2, vec2 } from './vec2';
import initWasm, { SoftBodyWorldHandle } from './wasm/softbody_wasm';

let wasmReady: Promise<void> | null = null;

/** Load the wasm module. Idempotent — every call after the first returns
 *  the same in-flight promise. Game bootstrap should `await` once before
 *  constructing the engine. */
export function loadWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm().then(() => {});
  }
  return wasmReady;
}

export interface RustEngineConfig {
  gravity?: Vec2;
  substeps?: number;
  rngSeed?: number;
}

const MATERIAL_TO_ID: Record<SurfaceMaterial, number> = {
  default: 0, ice: 1, sticky: 2, bouncy: 3,
};

function emptyVec(): Vec2 { return { x: 0, y: 0 }; }

function flatten(points: Vec2[]): Float64Array {
  const buf = new Float64Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    buf[i * 2] = points[i].x;
    buf[i * 2 + 1] = points[i].y;
  }
  return buf;
}

function unflatten(buf: Float64Array): Vec2[] {
  const n = buf.length >> 1;
  const out: Vec2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = { x: buf[i * 2], y: buf[i * 2 + 1] };
  }
  return out;
}

export class SoftBodyWorldRust implements SoftBodyEngine {
  private h: SoftBodyWorldHandle;

  // TS-sim parity: callers grab a `StaticSurface` reference from
  // registerStaticPolygon and later pass it back to removeStaticSurface.
  // The wasm side uses integer indices. We track both, with a small
  // pitfall: when a surface is removed, every index above it shifts
  // down. We rebuild the map on remove.
  private surfaceMap: { surface: StaticSurface; wasmIdx: number }[] = [];

  // Listener registries — assigned via the SoftBodyEngine `onTriggerEntered`
  // setter, which mirrors the TS sim's chained-callback model.
  public onTriggerEntered: ((shapeIdx: number, blobId: number) => void) | undefined = undefined;
  public onTriggerExited:  ((shapeIdx: number, blobId: number) => void) | undefined = undefined;
  public onBlobCrushed:    ((blobId: number) => void) | undefined = undefined;

  // EngineRng implementation that proxies to the wasm RNG.
  public readonly rng: EngineRng = {
    next: () => this.h.rngNextUnit(),
    int: (min: number, max: number) => min + Math.floor(this.h.rngNextUnit() * (max - min)),
    range: (min: number, max: number) => min + this.h.rngNextUnit() * (max - min),
    bool: () => this.h.rngNextUnit() < 0.5,
    getState: () => this.h.rngState(),
    setState: (s: number) => this.h.setRngState(s),
  };

  // Per-particle writes / tick override
  setParticlePos(i: number, x: number, y: number): void { this.h.setParticlePos(i, x, y); }
  setParticleVel(i: number, x: number, y: number): void { this.h.setParticleVel(i, x, y); }
  /** Align the wasm tick with the host's authoritative tick. The guest's
   *  lockstep gate looks for input at `world.tick + 1`; without this
   *  the guest sits at tick 0 forever while the host broadcasts inputs
   *  for tick 600+, and the local sim never advances between keyframes. */
  setTick(t: number): void { this.h.setTick(t); }

  // Materialized read-only views of mass / invMass / fixedDt. Not used
  // by hot-path code, but the interface requires them.
  get mass(): readonly number[] {
    // Building this each access is wasteful — fortunately nothing in
    // the game reads it per-frame; powerupManager.ts reads it during
    // mass-scale snapshot which is per-event.
    const n = this.h.particleCount();
    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = 0; // wasm doesn't expose mass — see note
    return out;
  }
  get invMass(): readonly number[] {
    return Array.from(this.h.getInvMass() as Float64Array);
  }
  get fixedDt(): number { return 1 / 60; }

  constructor(config: RustEngineConfig = {}) {
    const gravity = config.gravity ?? vec2(0, 980 * 4);
    const substeps = config.substeps ?? 2;
    const seed = config.rngSeed ?? 1;
    this.h = new SoftBodyWorldHandle(seed, gravity.x, gravity.y, substeps);
  }

  /** Free the wasm handle. Call when the game tears down to avoid
   *  leaking wasm memory across hot-reloads in dev. */
  dispose(): void {
    this.h.free();
  }

  // ---- core loop ----

  get tick(): number { return this.h.tick; }

  // ---- read-only state snapshots ----
  // These are materialized on every access — fine per-frame, expensive
  // per-particle in a tight loop. Callers should hoist a single read out
  // of any loop they write.

  get pos(): readonly Vec2[] { return this.getPositions(); }
  get vel(): readonly Vec2[] { return this.getVelocities(); }
  get blobRanges(): readonly BlobRange[] {
    const out: BlobRange[] = [];
    const n = this.h.blobCount();
    for (let i = 0; i < n; i++) {
      const buf = this.h.getBlobRange(i);
      if (buf.length === 0) continue;
      const hullLen = buf[2];
      out.push({
        id: i,
        start: buf[0],
        end: buf[1],
        hull: Array.from(buf.subarray(3, 3 + hullLen)),
        // Fields the renderer/managers don't read on the hot path —
        // safe defaults so the type satisfies BlobRange.
        shapeIdx: i, springBegin: 0, springEnd: 0,
        springStiffnessScale: 1, springDampScale: 1,
        sortKey: '',
      });
    }
    return out;
  }
  get staticSurfaces(): readonly StaticSurface[] { return this.getStaticSurfacesSnapshot(); }
  get shapes(): readonly Shape[] { return this.getShapesSnapshot(); }

  step(delta: number): void {
    this.h.step(delta);
    // Drain trigger events.
    const enter = this.h.takeTriggerEntered();
    if (enter.length && this.onTriggerEntered) {
      for (let i = 0; i < enter.length; i += 2) {
        this.onTriggerEntered(enter[i], enter[i + 1]);
      }
    }
    const exit = this.h.takeTriggerExited();
    if (exit.length && this.onTriggerExited) {
      for (let i = 0; i < exit.length; i += 2) {
        this.onTriggerExited(exit[i], exit[i + 1]);
      }
    }
    // Drain crush events. Even without a listener attached, draining
    // prevents the queue from growing unboundedly.
    const crushed = this.h.takeCrushEvents();
    if (crushed.length && this.onBlobCrushed) {
      for (let i = 0; i < crushed.length; i++) {
        this.onBlobCrushed(crushed[i]);
      }
    }
  }

  // ---- world setup ----

  registerStaticPolygon(
    poly: Vec2[],
    material: SurfaceMaterial = 'default',
    id?: string,
    _opts?: { layer?: number; mask?: number },
  ): StaticSurface {
    const wasmIdx = this.h.registerStaticPolygon(flatten(poly), MATERIAL_TO_ID[material]);
    // Build the equivalent JS-side StaticSurface so callers can hold a
    // reference and pass it back to removeStaticSurface.
    const surface: StaticSurface = {
      poly: poly.map(p => ({ x: p.x, y: p.y })),
      material, id,
    };
    this.surfaceMap.push({ surface, wasmIdx });
    return surface;
  }

  removeStaticSurface(surface: StaticSurface): void {
    const i = this.surfaceMap.findIndex(e => e.surface === surface);
    if (i < 0) return;
    const wasmIdx = this.surfaceMap[i].wasmIdx;
    this.h.removeStaticSurface(wasmIdx);
    this.surfaceMap.splice(i, 1);
    // Re-map any surfaces whose wasm index was above the removed one.
    for (const e of this.surfaceMap) if (e.wasmIdx > wasmIdx) e.wasmIdx -= 1;
  }

  clearStaticPolygons(): void {
    this.h.clearStaticPolygons();
    this.surfaceMap = [];
  }

  /** Sync a mutated JS-side `StaticSurface` (poly + velocity) into the
   *  wasm world. PlatformMover / SpringPadManager mutate `.poly[i]`
   *  vertices directly each frame; this call pushes those mutations
   *  across the boundary. Looking up `surface` is O(N) over registered
   *  surfaces — fine because N is small (a handful per level). */
  commitStaticSurface(surface: StaticSurface): void {
    const entry = this.surfaceMap.find(e => e.surface === surface);
    if (!entry) return;
    const v = surface.velocity;
    const hasVel = v !== undefined;
    this.h.updateStaticSurface(
      entry.wasmIdx,
      flatten(surface.poly),
      hasVel ? v!.x : 0,
      hasVel ? v!.y : 0,
      hasVel,
    );
  }

  registerTriggerPolygon(poly: Vec2[], gravityOverride?: Vec2 | GravityField): number {
    if (!gravityOverride) {
      return this.h.registerTriggerPolygon(flatten(poly), NaN, NaN);
    }
    if ('kind' in gravityOverride) {
      if (gravityOverride.kind === 'uniform') {
        return this.h.registerTriggerPolygon(flatten(poly),
          gravityOverride.vector.x, gravityOverride.vector.y);
      }
      // point field
      return this.h.registerTriggerPointGravity(flatten(poly),
        gravityOverride.center.x, gravityOverride.center.y,
        gravityOverride.strength,
        gravityOverride.falloff === 'inverseSquare');
    }
    // Plain Vec2: uniform field
    return this.h.registerTriggerPolygon(flatten(poly),
      gravityOverride.x, gravityOverride.y);
  }

  // ---- blob lifecycle ----

  addBlobFromHull(params: AddBlobFromHullParams): BlobResult {
    const centerLocal = params.centerLocal ?? { x: 0, y: 0 };
    const staticHull = new Uint32Array(params.staticHullIndices ?? []);
    // The trailing `pinFrame` arg is added by the new wasm-bindings — run
    // `npm run build:wasm` to regenerate the bindings after pulling. Until
    // then this falls through `as any` so the TS side typechecks; the param
    // is ignored by an older binding (extra args are dropped).
    const handle = (this.h as any).addBlobFromHull(
      flatten(params.hullRestLocal),
      centerLocal.x, centerLocal.y,
      params.centerMass, params.hullMass,
      params.springK, params.springDamp,
      params.radialK, params.radialDamp,
      params.pressureK,
      params.shapeMatchK, params.shapeMatchDamp,
      params.worldOrigin.x, params.worldOrigin.y,
      params.sortKey ?? '',
      staticHull,
      params.staticCenter ?? false,
      params.pinFrame ?? false,
    );
    return {
      blobId: handle.blob_id,
      centerIdx: handle.center_idx,
      hullIndices: Array.from(handle.hullIndices),
      shapeIdx: handle.shape_idx,
    };
  }

  removeBlob(blobId: number): void { this.h.removeBlob(blobId); }

  // ---- per-blob tuning ----

  setBlobSpringStiffnessScale(blobId: number, stiffness: number, damp: number = -1): void {
    this.h.setBlobSpringStiffnessScale(blobId, stiffness, damp);
  }
  setBlobShapeMatchRestScale(blobId: number, s: number): void {
    this.h.setBlobShapeMatchRestScale(blobId, s);
  }
  setBlobRestLocal(blobId: number, restLocal: Vec2[]): void {
    this.h.setBlobRestLocal(blobId, flatten(restLocal));
  }
  setBlobSquashLean(blobId: number, squash: number, lean: number, gravityDir: Vec2): void {
    this.h.setBlobSquashLean(blobId, squash, lean, gravityDir.x, gravityDir.y);
  }
  setBlobMassScale(blobId: number, scale: number): void {
    this.h.setBlobMassScale(blobId, scale);
  }
  resetBlobMassScale(blobId: number): void {
    this.h.resetBlobMassScale(blobId);
  }
  setBlobGravityOverride(blobId: number, gravity: Vec2 | null): void {
    if (gravity === null) this.h.setBlobGravityOverride(blobId, 0, 0, true);
    else                  this.h.setBlobGravityOverride(blobId, gravity.x, gravity.y, false);
  }

  // ---- per-blob mutation ----

  nudgeBlob(blobId: number, dx: number, dy: number): void { this.h.nudgeBlob(blobId, dx, dy); }
  teleportBlob(blobId: number, target: Vec2): void { this.h.teleportBlob(blobId, target.x, target.y); }
  zeroBlobVelocity(blobId: number): void { this.h.zeroBlobVelocity(blobId); }
  pinBlobToCurrentPose(blobId: number): void { this.h.pinBlobToCurrentPose(blobId); }
  unpinBlob(blobId: number): void { this.h.unpinBlob(blobId); }

  // ---- forces / impulses ----

  applyBlobMoveForce(blobId: number, move: Vec2, force: number, dt: number): void {
    this.h.applyBlobMoveForce(blobId, move.x, move.y, force, dt);
  }
  applyBlobLinearVelocityDelta(blobId: number, deltaV: Vec2): void {
    this.h.applyBlobLinearVelocityDelta(blobId, deltaV.x, deltaV.y);
  }
  setBlobTread(blobId: number, strength: number): void {
    this.h.setBlobTread(blobId, strength);
  }

  // ---- Phase 3 zone-force APIs ----
  blobsOverlappingPolygon(polygon: Float64Array): Uint32Array {
    return this.h.blobsOverlappingPolygon(polygon);
  }
  applyForceInPolygonUniform(polygon: Float64Array, fx: number, fy: number, dt: number): void {
    this.h.applyForceInPolygonUniform(polygon, fx, fy, dt);
  }
  applyForceInPolygonRadial(
    polygon: Float64Array,
    cx: number, cy: number,
    strength: number, radius: number,
    falloff: 0 | 1,
    dt: number,
  ): void {
    this.h.applyForceInPolygonRadial(polygon, cx, cy, strength, radius, falloff, dt);
  }
  applyForceInPolygonDrag(polygon: Float64Array, coefficient: number, dt: number): void {
    this.h.applyForceInPolygonDrag(polygon, coefficient, dt);
  }

  // ---- Phase 4 dynamic-item wrappers ----
  addCannon(id: number, x: number, y: number, w: number, h: number, rotation: number): number {
    return this.h.addCannon(id, x, y, w, h, rotation);
  }
  addCatapult(id: number, x: number, y: number, w: number, h: number): number {
    return this.h.addCatapult(id, x, y, w, h);
  }
  addBumper(id: number, x: number, y: number, radius: number): number {
    return this.h.addBumper(id, x, y, radius);
  }
  addWindZone(id: number, x: number, y: number, w: number, h: number, rotation: number): number {
    return this.h.addWindZone(id, x, y, w, h, rotation);
  }
  addGravityFlipper(id: number, x: number, y: number, w: number, h: number): number {
    return this.h.addGravityFlipper(id, x, y, w, h);
  }
  addConveyor(id: number, x: number, y: number, w: number, h: number, direction: 1 | -1): number {
    return this.h.addConveyor(id, x, y, w, h, direction);
  }
  addStickyGoo(id: number, x: number, y: number, w: number, h: number): number {
    return this.h.addStickyGoo(id, x, y, w, h);
  }
  addWreckingBall(id: number, x: number, y: number): number {
    return this.h.addWreckingBall(id, x, y);
  }
  clearDynamicItems(): void { this.h.clearDynamicItems(); }
  dynamicItemCount(): number { return this.h.dynamicItemCount(); }
  dynamicItemActive(idx: number): boolean { return this.h.dynamicItemActive(idx); }

  // ---- Phase 5 spring-pad wrappers ----
  addSpringPad(id: number, x: number, y: number, width: number, height: number, rotation: number, fireSpeedOverride: number): number {
    return this.h.addSpringPad(id, x, y, width, height, rotation, fireSpeedOverride);
  }
  clearSpringPads(): void { this.h.clearSpringPads(); }
  springPadCount(): number { return this.h.springPadCount(); }
  springPadState(idx: number): number { return this.h.springPadState(idx); }
  springPadOffset(idx: number): number { return this.h.springPadOffset(idx); }
  takeSpringPadFireEvents(): Uint32Array { return this.h.takeSpringPadFireEvents(); }

  /**
   * Pump (expand) impulse on a blob's hull edges. Computed JS-side from
   * the hull polygon + a single iteration: cheaper than crossing the
   * wasm boundary per-edge, and the polygon is already a fresh snapshot
   * we'd have to fetch anyway.
   */
  applyBlobExpand(blobId: number, expandForce: number): void {
    const range = this.h.getBlobRange(blobId);
    if (range.length === 0) return;
    const hullLen = range[2];
    const hullStart = 3;
    const hullIndices = range.subarray(hullStart, hullStart + hullLen);
    const center = unflatten(this.h.getParticlePos(range[0]))[0];
    const hullPos: Vec2[] = [];
    for (let i = 0; i < hullLen; i++) {
      const p = this.h.getParticlePos(hullIndices[i]);
      hullPos.push({ x: p[0], y: p[1] });
    }
    let perim = 0;
    for (let k = 0; k < hullLen; k++) {
      const a = hullPos[k], b = hullPos[(k + 1) % hullLen];
      perim += Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (perim < 1e-6) return;
    const base = expandForce * (hullLen * 0.5);
    for (let k = 0; k < hullLen; k++) {
      const a = hullPos[k], b = hullPos[(k + 1) % hullLen];
      const ex = b.x - a.x, ey = b.y - a.y;
      const el = Math.hypot(ex, ey);
      if (el < 1e-6) continue;
      const midX = (a.x + b.x) * 0.5, midY = (a.y + b.y) * 0.5;
      // outward normal (perp to edge, flipped to point away from center)
      let nx = -ey, ny = ex;
      if (nx * (center.x - midX) + ny * (center.y - midY) > 0) {
        nx = -nx; ny = -ny;
      }
      const inv = 1 / Math.hypot(nx, ny);
      nx *= inv; ny *= inv;
      const j = base * (el / perim);
      this.h.applyExternalForcePoint(hullIndices[k],     nx * j, ny * j);
      this.h.applyExternalForcePoint(hullIndices[(k + 1) % hullLen], nx * j, ny * j);
    }
  }

  applyExternalForcePoint(i: number, f: Vec2): void {
    this.h.applyExternalForcePoint(i, f.x, f.y);
  }

  // ---- network sync ----

  setBlobGroundContacts(blobId: number, count: number): void {
    this.h.setBlobGroundContacts(blobId, count);
  }
  getBlobGroundContacts(blobId: number): number {
    return this.h.getBlobGroundContacts(blobId);
  }
  getBlobGroundContact(blobId: number): GroundContact | null {
    const buf = this.h.getBlobGroundContact(blobId);
    if (!buf) return null;
    return { point: { x: buf[0], y: buf[1] }, normal: { x: buf[2], y: buf[3] }, poly: null };
  }
  getBlobImpactContact(blobId: number): GroundContact | null {
    const buf = this.h.getBlobImpactContact(blobId);
    if (!buf) return null;
    return { point: { x: buf[0], y: buf[1] }, normal: { x: buf[2], y: buf[3] }, poly: null };
  }
  getBlobStickyContact(blobId: number): StickyContact {
    const buf = this.h.getBlobStickyContact(blobId);
    return { count: buf[0], normal: { x: buf[1], y: buf[2] } };
  }
  getBlobParticleContacts(blobId: number): Uint8Array {
    return this.h.getBlobParticleContacts(blobId);
  }
  getBlobEffectiveGravity(blobId: number): Vec2 {
    const buf = this.h.getBlobEffectiveGravity(blobId);
    return { x: buf[0], y: buf[1] };
  }
  getBlobShapeMatchTargetHull(blobId: number): Vec2[] {
    return unflatten(this.h.getBlobShapeMatchTargetHull(blobId));
  }

  // ---- queries ----

  getPositions(): Vec2[] { return unflatten(this.h.getPositions()); }
  getVelocities(): Vec2[] { return unflatten(this.h.getVelocities()); }
  getHullPolygon(blobId: number): Vec2[] { return unflatten(this.h.getHullPolygon(blobId)); }
  getBlobCount(): number { return this.h.blobCount(); }
  /** Cheap particle-count read — single wasm call, no allocation. */
  particleCount(): number { return this.h.particleCount(); }

  getBlobRange(blobId: number): { start: number; end: number; hull: readonly number[] } | null {
    const buf = this.h.getBlobRange(blobId);
    if (buf.length === 0) return null;
    return {
      start: buf[0],
      end: buf[1],
      hull: Array.from(buf.subarray(3, 3 + buf[2])),
    };
  }

  getSpringIndexPairs(): [number, number][] {
    const buf = this.h.getSpringIndexPairs();
    const out: [number, number][] = [];
    for (let i = 0; i < buf.length; i += 2) out.push([buf[i], buf[i + 1]]);
    return out;
  }

  // ---- level-author additions ----

  addParticle(p: Vec2, v: Vec2, m: number, radius: number): number {
    return this.h.addParticle(p.x, p.y, v.x, v.y, m, radius);
  }

  addRopeChain(idxA: number, idxB: number, opts: RopeChainOpts): RopeChainResult {
    const LAYER_CHAIN = 0b00000100;
    const LAYER_WORLD = 0b00001000;
    const inner = this.h.addRopeChain(
      idxA, idxB,
      opts.totalLength,
      opts.maxSegmentLength,
      opts.segmentMass ?? 0.5,
      opts.segmentRadius ?? 10,
      opts.layer ?? LAYER_CHAIN,
      opts.mask ?? LAYER_WORLD,
      opts.iterations ?? 12,
    );
    return { particleIndices: Array.from(inner) };
  }

  addBlobTether(blobA: number, blobB: number, slack: number, stiffness: number, maxForce: number): void {
    this.h.addBlobTether(blobA, blobB, slack, stiffness, maxForce);
  }

  addExtraSpring(i: number, j: number, rest: number, k: number, damp: number): void {
    this.h.addExtraSpring(i, j, rest, k, damp);
  }
  addHomeAnchor(idx: number, home: Vec2, k: number, damp: number): void {
    this.h.addHomeAnchor(idx, home.x, home.y, k, damp);
  }
  addDistanceMax(i: number, j: number, max: number): void {
    this.h.addDistanceMax(i, j, max);
  }

  // ---- snapshots for renderer ----

  getStaticSurfacesSnapshot(): readonly StaticSurface[] {
    const buf = this.h.staticSurfacesSnapshot();
    const out: StaticSurface[] = [];
    let i = 0;
    const matNames: SurfaceMaterial[] = ['default', 'ice', 'sticky', 'bouncy'];
    while (i < buf.length) {
      const matId = buf[i++] | 0;
      const count = buf[i++] | 0;
      const poly: Vec2[] = new Array(count);
      for (let k = 0; k < count; k++) {
        poly[k] = { x: buf[i++], y: buf[i++] };
      }
      out.push({ poly, material: matNames[matId] ?? 'default' });
    }
    return out;
  }

  getShapesSnapshot(includeTriggers = true): readonly Shape[] {
    const buf = this.h.shapesSnapshot(includeTriggers);
    const out: Shape[] = [];
    let i = 0;
    while (i < buf.length) {
      const _shapeIdx = buf[i++] | 0;
      const flags = buf[i++] | 0;
      // Gravity field metadata (4 doubles, layout depends on `gravKind`).
      const gravKind = buf[i++] | 0;
      const g0 = buf[i++];
      const g1 = buf[i++];
      const g2 = buf[i++];
      let gravityField: GravityField | null = null;
      if (gravKind === 1) {
        gravityField = { kind: 'uniform', vector: { x: g0, y: g1 } };
      } else if (gravKind === 2 || gravKind === 3) {
        gravityField = {
          kind: 'point',
          center: { x: g0, y: g1 },
          strength: g2,
          falloff: gravKind === 3 ? 'inverseSquare' : 'linear',
        };
      }
      const count = buf[i++] | 0;
      const poly: Vec2[] = new Array(count);
      for (let k = 0; k < count; k++) poly[k] = { x: buf[i++], y: buf[i++] };
      const isTrigger = (flags & 1) !== 0;
      const isStatic = (flags & 2) !== 0;
      const inactive = (flags & 4) !== 0;
      // Minimal Shape shape — renderer mostly needs `staticPoly`/`indices`,
      // the boolean flags, and `gravityField` for gravity-zone visuals.
      out.push({
        indices: [],
        staticPoly: isStatic ? poly : [],
        isTrigger, isStatic,
        targetRestArea: 0, pressureK: 0, shapeMatchK: 0, shapeMatchDamp: 0,
        restLocal: [], shapeMatchRestScale: 1,
        useFrameOverride: false,
        frameOverride: { cos: 1, sin: 0, tx: 0, ty: 0 },
        gravityField,
        centerIdx: -1,
        inactive,
      });
    }
    return out;
  }

  setRngSeed(seed: number): void { this.h.setRngSeed(seed); }

  // ---- determinism aid ----

  /** Hex string of the FNV-1a 64-bit hash of every (pos,vel) raw integer. */
  stateHash(): string {
    const big = this.h.stateHash();
    return '0x' + big.toString(16).padStart(16, '0');
  }

  /** Bulk position write — actionManager rewind hot path. */
  setPositionsBulk(buf: Float64Array): void {
    this.h.setPositionsBulk(buf);
  }

  /** Capture full mutable engine state for rollback netcode. */
  serializeState(): Uint8Array { return this.h.serializeState(); }
  /** Restore from a snapshot. Returns false if the buffer is malformed
   *  or doesn't match this engine's layout (particle/blob/shape counts). */
  restoreState(buf: Uint8Array): boolean { return this.h.restoreState(buf); }
}
