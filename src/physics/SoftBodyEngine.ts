// The contract every softbody engine implements. Both the legacy
// TS float sim (`softBodyWorld.ts`) and the wasm-backed Rust integer
// sim (`softBodyWorldRust.ts`) satisfy this interface, and the rest
// of the game programs against it via `engineSelector.createSoftBodyEngine`.
//
// The interface intentionally mirrors the original SoftBodyWorld class
// surface — methods only, with the read-only properties exposed as
// getters or query methods. This lets us swap in the Rust engine
// without rewriting every call site (most of which talk to the engine
// through a `world: SoftBodyEngine` reference).
//
// Hot-path notes:
//   - `getPositions()` / `getVelocities()` are called per frame by the
//     renderer. They return fresh arrays — callers should treat them
//     as read-only snapshots, not as live references into engine state.
//   - For per-particle reads in tight loops, prefer the bulk getters
//     (one wasm call, then iterate the typed buffer locally).
//   - For per-particle writes (action-manager rewind), use the bulk
//     `setPositionsBulk(buf: Float64Array)` setter on engines that
//     expose it — see `BulkParticleSetter` below.

import { Vec2 } from './vec2';
import {
  BlobRange, BlobResult, GravityField, MaterialParams, PumpEdge,
  RayHit, Shape, StaticSurface, SurfaceMaterial, Transform2D,
} from './types';

export interface AddBlobFromHullParams {
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
  sortKey?: string;
  staticHullIndices?: number[];
  staticCenter?: boolean;
  /** Lock the shape-match frame to (worldOrigin, identity). Whole blob
   *  stays rooted without per-vertex anchors. */
  pinFrame?: boolean;
}

export interface RopeChainOpts {
  totalLength: number;
  maxSegmentLength: number;
  segmentMass?: number;
  segmentRadius?: number;
  layer?: number;
  mask?: number;
  iterations?: number;
}

export interface RopeChainResult { particleIndices: number[]; }

export interface GroundContact {
  point: Vec2;
  normal: Vec2;
  poly: Vec2[] | null;
}

export interface StickyContact {
  count: number;
  normal: Vec2;
}

/** RNG draws routed through the engine — same stream visible to both
 *  the engine and game code (powerups, spike spawns, AI). Mirrors
 *  `SeededRng` in lib/rng.ts so existing callers don't need to change. */
export interface EngineRng {
  next(): number;      // [0, 1)
  int(min: number, max: number): number;
  range(min: number, max: number): number;
  bool(): boolean;
  getState(): number;
  setState(state: number): void;
}

/** Engines that support a single-buffer bulk write — used by the
 *  action-manager rewind path so it can replace every particle position
 *  in one wasm call. The TS engine implements this trivially. */
export interface BulkParticleSetter {
  setPositionsBulk?(buf: Float64Array): void;
}

export interface SoftBodyEngine extends BulkParticleSetter {
  // ---- core loop ----
  step(delta: number): void;
  readonly tick: number;
  /** Cheap particle-count read. Doesn't allocate (unlike `.pos.length`
   *  on the wasm wrapper, which materializes a fresh Vec2[] each call). */
  particleCount(): number;

  // ---- read-only state snapshots (renderers / managers iterate these
  // each frame — TS sim exposes them directly; the Rust wrapper
  // materializes a fresh snapshot per access). ----
  readonly pos: readonly Vec2[];
  readonly vel: readonly Vec2[];
  readonly mass: readonly number[];
  readonly invMass: readonly number[];
  readonly blobRanges: readonly BlobRange[];
  readonly staticSurfaces: readonly StaticSurface[];
  readonly shapes: readonly Shape[];
  readonly fixedDt: number;

  // ---- per-particle writes (action-manager rewind, network snapshot) ----
  setParticlePos(i: number, x: number, y: number): void;
  setParticleVel(i: number, x: number, y: number): void;
  /** Override the logical tick counter — used by netcode keyframe restore. */
  setTick(t: number): void;

  // ---- world setup ----
  registerStaticPolygon(poly: Vec2[], material?: SurfaceMaterial, id?: string,
    opts?: { layer?: number; mask?: number }): StaticSurface;
  removeStaticSurface(surface: StaticSurface): void;
  clearStaticPolygons(): void;

  /** Push a static surface's mutated `poly` + `velocity` into the
   *  engine. No-op on the TS sim (the surface object IS the engine's
   *  copy, mutations apply instantly); required on the wasm engine
   *  where the JS-side surface is a separate object from the wasm
   *  state. Call after mutating `surface.poly[i].x|.y` or
   *  `surface.velocity`. */
  commitStaticSurface(surface: StaticSurface): void;
  registerTriggerPolygon(poly: Vec2[], gravityOverride?: Vec2 | GravityField): number;

  // ---- blob lifecycle ----
  addBlobFromHull(params: AddBlobFromHullParams): BlobResult;
  removeBlob(blobId: number): void;

  // ---- per-blob tuning ----
  setBlobSpringStiffnessScale(blobId: number, stiffnessScale: number, dampScale?: number): void;
  setBlobShapeMatchRestScale(blobId: number, s: number): void;
  setBlobRestLocal(blobId: number, restLocal: Vec2[]): void;
  setBlobMassScale(blobId: number, massScale: number): void;
  resetBlobMassScale(blobId: number): void;
  setBlobGravityOverride(blobId: number, gravity: Vec2 | null): void;

  // ---- per-blob mutation ----
  nudgeBlob(blobId: number, dx: number, dy: number): void;
  teleportBlob(blobId: number, target: Vec2): void;
  zeroBlobVelocity(blobId: number): void;
  pinBlobToCurrentPose(blobId: number): void;
  unpinBlob(blobId: number): void;

  // ---- forces / impulses ----
  applyBlobMoveForce(blobId: number, move: Vec2, force: number, dt: number): void;
  applyBlobLinearVelocityDelta(blobId: number, deltaV: Vec2): void;
  applyBlobExpand(blobId: number, expandForce: number): void;
  applyExternalForcePoint(i: number, f: Vec2): void;

  // ---- network sync ----
  setBlobGroundContacts(blobId: number, count: number): void;
  getBlobGroundContacts(blobId: number): number;
  getBlobGroundContact(blobId: number): GroundContact | null;
  getBlobImpactContact(blobId: number): GroundContact | null;
  getBlobStickyContact(blobId: number): StickyContact;
  getBlobEffectiveGravity(blobId: number): Vec2;
  getBlobShapeMatchTargetHull(blobId: number): Vec2[];

  // ---- queries ----
  getPositions(): Vec2[];
  getVelocities(): Vec2[];
  getHullPolygon(blobId: number): Vec2[];
  getBlobCount(): number;
  /** Returns the contiguous particle index range owned by a blob and its hull indices. */
  getBlobRange(blobId: number): { start: number; end: number; hull: readonly number[] } | null;
  getSpringIndexPairs(): [number, number][];

  // ---- level-author additions ----
  addParticle(p: Vec2, v: Vec2, m: number, radius: number): number;
  addRopeChain(idxA: number, idxB: number, opts: RopeChainOpts): RopeChainResult;
  /** Add a spring outside any blob (point shapes, ropes). */
  addExtraSpring(i: number, j: number, rest: number, k: number, damp: number): void;
  /** Pull a particle toward a fixed world-position with k/damp. */
  addHomeAnchor(idx: number, home: Vec2, k: number, damp: number): void;
  /** Hard max-distance constraint between two particles. Independent of
   * the chain solver — use when you need a rigid leash regardless of
   * mass ratios or segment count. */
  addDistanceMax(i: number, j: number, max: number): void;

  // ---- snapshots for the renderer ----
  /** Snapshot of every static surface — safe to iterate per frame. */
  getStaticSurfacesSnapshot(): readonly StaticSurface[];
  /** Snapshot of every shape (optionally excluding triggers). */
  getShapesSnapshot(includeTriggers?: boolean): readonly Shape[];

  // ---- RNG (game code consumes draws for AI / powerups / spike spawns) ----
  readonly rng: EngineRng;

  // ---- RNG seed reset (for netcode handshake / replay) ----
  setRngSeed(seed: number): void;

  // ---- trigger callbacks (single assignable property — game code
  // already chains by wrapping the prior value). ----
  onTriggerEntered?: ((shapeIdx: number, blobId: number) => void) | undefined;
  onTriggerExited?:  ((shapeIdx: number, blobId: number) => void) | undefined;

  /** Fired when the physics solver detects a blob has exploded — e.g.
   *  a platform crushed it against static geometry until the position
   *  solver lost control. Game-side handler converts this into a kill
   *  through the normal `spikeManager.killPlayer` path. Only the Rust
   *  engine emits these; the TS sim leaves this hook unimplemented. */
  onBlobCrushed?: ((blobId: number) => void) | undefined;

  // ---- determinism aid (Rust engine: FNV-1a of state; TS engine:
  // returns a string hash for development comparison). ----
  stateHash(): string;

  // ---- snapshot/restore (rollback netcode). The Rust engine returns
  // a binary buffer; the TS sim's stubs return an empty buffer and
  // accept-but-ignore restores (rollback is wasm-only). ----
  serializeState(): Uint8Array;
  restoreState(buf: Uint8Array): boolean;
}

/* Re-export types for callers that import everything from the engine module. */
export type {
  BlobRange, BlobResult, GravityField, MaterialParams, PumpEdge, RayHit,
  Shape, StaticSurface, SurfaceMaterial, Transform2D,
};
